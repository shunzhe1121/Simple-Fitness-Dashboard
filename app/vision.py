"""拍照识餐：把食物照片交给视觉模型，产出 parser 能解析的文本块。

单独抽一层的原因是 DeepSeek 官方只有文本模型，识图必须另配一个多模态模型
（VISION_MODEL）。但输出格式与「把豆包结果粘回来」完全一致，都是 ### 分块，
所以后面的解析、预览、入库链路一行都不用改。

模型没配时不报错，返回一段可读的提示，前端照常展示。
"""

from __future__ import annotations

import base64
import io
import uuid
from pathlib import Path

import requests
from PIL import Image, ImageOps

from . import config, parser

# 落盘规格：长边压到 1280、JPEG q85。
# 手机原图动辄 4-8 MB，base64 之后还要再涨三成，既慢又容易撞接口体积上限；
# 1280 对「认出一盘菜是什么、大概多少量」这个任务的清晰度绰绰有余。
MAX_SIDE = 1280
JPEG_QUALITY = 85

REQUEST_TIMEOUT = 150

# 允许接收的图片类型
ALLOWED_MIME = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/bmp",
}


class VisionError(Exception):
    """识图过程中的可预期错误，消息直接给用户看。"""


def _normalize(raw: bytes) -> bytes:
    """纠正方向、限制长边、统一转 JPEG，返回新的字节流。

    手机拍的照片方向信息在 EXIF 里，不转正的话识别出来的图可能是躺倒的。
    """
    try:
        image = Image.open(io.BytesIO(raw))
        image = ImageOps.exif_transpose(image)
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buffer.getvalue()
    except Exception as error:  # noqa: BLE001 — Pillow 抛的异常种类多
        raise VisionError(f"图片无法解析，可能格式不支持或文件损坏：{error}") from error


def save_image(raw: bytes, original_name: str, day: str) -> dict:
    """压缩后落盘，返回存储信息（stored_name 是相对 data/meals 的路径）。"""
    data = _normalize(raw)
    target_dir = config.MEALS_DIR / day
    target_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{day}/{uuid.uuid4().hex}.jpg"
    (config.MEALS_DIR / stored_name).write_bytes(data)
    return {
        "stored_name": stored_name,
        "original": original_name,
        "mime": "image/jpeg",
        "bytes": len(data),
    }


def image_path(stored_name: str) -> Path:
    """把数据库里的相对路径还原为绝对路径。"""
    return config.MEALS_DIR / stored_name


def _explain_http(status: int, body: str) -> str:
    """把接口报错翻译成人话，省得对着 400 猜。"""
    snippet = (body or "").strip()[:300]
    if status == 401:
        return "鉴权失败：API key 不对或没有该模型的权限（401）"
    if status == 403:
        return "没有权限调用该模型（403），检查 key 的可见模型范围"
    if status == 404:
        return "模型不存在（404），检查 VISION_MODEL 是否写对"
    if status == 429:
        return "请求过于频繁或额度不足（429）"
    if status == 402:
        return f"账户余额不足（402）：{snippet}"
    if status == 400 and "image" in snippet.lower():
        return f"当前模型不接受图片输入，需要换成多模态模型（400）：{snippet}"
    return f"接口返回 {status}：{snippet}"


def analyze(path: Path, meal_hint: str | None = None) -> dict:
    """识别单张图片。

    返回 {"text": str, "error": str | None}。识别失败不抛异常，
    让批量处理可以跳过坏图继续跑，最后统一汇报。
    """
    if not config.vision_configured():
        return {
            "text": "",
            "error": (
                "还没配置视觉模型。DeepSeek 官方只有文本模型，"
                "想用拍照识餐需要在 .env 里补 VISION_API_KEY / VISION_BASE_URL / "
                "VISION_MODEL，填一个多模态模型（如 SiliconFlow 的 Qwen-VL）。"
            ),
        }

    if not path.exists():
        return {"text": "", "error": f"图片文件不存在：{path.name}"}

    resolved = config.vision_config()
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")

    prompt = parser.DOUBAO_PROMPT
    if meal_hint:
        prompt += f"\n\n补充：这一餐按「{meal_hint}」归类。"

    payload = {
        "model": resolved["model"],
        "temperature": 0.1,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
                    },
                ],
            }
        ],
    }

    try:
        response = requests.post(
            f"{resolved['base_url']}/chat/completions",
            headers={
                "Authorization": f"Bearer {resolved['api_key']}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as error:
        return {"text": "", "error": f"网络请求失败：{error}"}

    if response.status_code != 200:
        return {"text": "", "error": _explain_http(response.status_code, response.text)}

    try:
        text = response.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        return {"text": "", "error": f"接口返回结构异常：{error}"}

    return {"text": (text or "").strip(), "error": None}


def merge_texts(texts: list[str]) -> str:
    """把多张图的识别结果拼成一段，交给 parser 一次解析。

    单张图的输出本身就是 ### 分块，直接拼接即可；
    补一个换行是防止上一张结尾没换行导致块粘连。
    """
    parts = [t.strip() for t in texts if t and t.strip()]
    return "\n".join(parts)
