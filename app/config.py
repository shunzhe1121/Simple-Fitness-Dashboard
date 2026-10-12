"""应用配置。

所有可变参数集中在这里读取，LLM 凭据默认留空：
拿到 API 之后只需填写 .env，无需改动任何代码。
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

# 项目根目录（app/ 的上一层）
BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")


def _text(key: str, default: str = "") -> str:
    """读取字符串配置，自动去除首尾空白。"""
    value = os.getenv(key)
    if value is None:
        return default
    return value.strip()


def _int(key: str, default: int) -> int:
    """读取整数配置，非法值回退到默认值。"""
    try:
        return int(_text(key) or default)
    except ValueError:
        return default


def _float(key: str, default: float) -> float:
    """读取浮点配置，非法值回退到默认值。"""
    try:
        return float(_text(key) or default)
    except ValueError:
        return default


# ---- LLM 接入配置（OpenAI 兼容）----
LLM_API_KEY = _text("LLM_API_KEY")
LLM_BASE_URL = _text("LLM_BASE_URL")
LLM_MODEL = _text("LLM_MODEL")
LLM_TEMPERATURE = _float("LLM_TEMPERATURE", 0.2)

# ---- 访问令牌 ----
# 走 Cloudflare 临时域名时服务直接暴露在公网，令牌是唯一凭据。
# 留空时会在首次启动自动生成并写回 .env；填 "off" 可显式关闭校验（仅限本机调试）。
ACCESS_TOKEN = _text("ACCESS_TOKEN")

COOKIE_NAME = "fit_access"
# 令牌有效期 180 天：手机「添加到主屏幕」后不必反复输入
COOKIE_MAX_AGE = 180 * 24 * 3600


def ensure_access_token() -> str:
    """确保存在访问令牌，没有就生成一个写回 .env 并返回。

    生成的是 URL 安全随机串，用途是拼出「带令牌的入口链接」——
    手机第一次用该链接打开一次，之后靠 cookie 免输。
    """
    global ACCESS_TOKEN
    if ACCESS_TOKEN:
        return ACCESS_TOKEN

    token = secrets.token_urlsafe(24)
    env_path = BASE_DIR / ".env"
    try:
        text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        if text and not text.endswith("\n"):
            text += "\n"
        if text:
            text += "\n"
        text += (
            "# 公网访问令牌（自动生成，勿外泄）。\n"
            "# 手机第一次用 地址/?k=令牌 打开一次，之后靠 cookie 免输。\n"
            f"ACCESS_TOKEN={token}\n"
        )
        env_path.write_text(text, encoding="utf-8")
    except OSError:
        # 写不进去也不影响本次运行，下次启动会再生成一个
        pass

    ACCESS_TOKEN = token
    return token


def access_enabled() -> bool:
    """是否开启访问校验。"""
    return bool(ACCESS_TOKEN) and ACCESS_TOKEN.lower() != "off"


# ---- 视觉识图配置（拍照识餐）----
# 不填则回落到上面的 LLM_*。注意 DeepSeek 官方只有文本模型，
# 想用拍照识餐必须单独配一个多模态模型（如 SiliconFlow 的 Qwen-VL）。
VISION_API_KEY = _text("VISION_API_KEY")
VISION_BASE_URL = _text("VISION_BASE_URL")
VISION_MODEL = _text("VISION_MODEL")


def vision_config() -> dict[str, str]:
    """视觉模型的生效配置：VISION_* 优先，缺项逐项回落到 LLM_*。"""
    return {
        "api_key": VISION_API_KEY or LLM_API_KEY,
        "base_url": (VISION_BASE_URL or LLM_BASE_URL).rstrip("/"),
        "model": VISION_MODEL or LLM_MODEL,
    }


def vision_configured() -> bool:
    """视觉识图是否可用。"""
    resolved = vision_config()
    return all(resolved.values())


def vision_status() -> dict:
    """给前端展示的视图配置状态。"""
    resolved = vision_config()
    return {
        "configured": vision_configured(),
        "model": resolved["model"],
        "base_url": resolved["base_url"],
        "api_key_set": bool(resolved["api_key"]),
        # 用于前端区分「完全没配」和「配了文本模型、但那个模型看不懂图」
        "own_key": bool(VISION_API_KEY),
    }


# ---- 佳明同步配置 ----
GARMIN_EMAIL = _text("GARMIN_EMAIL")
GARMIN_PASSWORD = _text("GARMIN_PASSWORD")

# 同步起算日（YYYY-MM-DD，留空 = 不限制）。
# 每天自动同步会回看最近 7 天，这个日期之前的记录一律跳过——
# 主要用于「清空历史、从某天重新开始」后，防止旧日期被回填复活。
# 觉得没用了把 .env 里那行删掉即可。
GARMIN_SINCE = _text("GARMIN_SINCE")

# 日报输出目录（MD 归档）
REPORTS_DIR = Path(_text("REPORTS_DIR", "data/reports"))
REPORTS_DIR = REPORTS_DIR if REPORTS_DIR.is_absolute() else BASE_DIR / REPORTS_DIR

# 餐食图片存放目录（按上传日期分子目录）
MEALS_DIR = Path(_text("MEALS_DIR", "data/meals"))
MEALS_DIR = MEALS_DIR if MEALS_DIR.is_absolute() else BASE_DIR / MEALS_DIR

# 单张图片上传上限（压缩前），超过直接拒掉，避免把磁盘塞满
MAX_IMAGE_MB = _float("MAX_IMAGE_MB", 15.0)

# ---- 服务监听配置 ----
HOST = _text("HOST", "0.0.0.0")
PORT = _int("PORT", 8000)

# ---- 数据存储配置 ----
_db_path = Path(_text("DB_PATH", "data/fitness.db"))
DB_PATH = _db_path if _db_path.is_absolute() else BASE_DIR / _db_path

# 对话历史保留天数
CHAT_HISTORY_DAYS = _int("CHAT_HISTORY_DAYS", 3)

# 静态资源目录
STATIC_DIR = BASE_DIR / "static"


def llm_configured() -> bool:
    """判断 LLM 是否已完成配置。

    三项缺任意一项都视为未配置，此时 Agent 对话会返回配置提示，
    但程序其余功能仍然可用。
    """
    return bool(LLM_API_KEY and LLM_BASE_URL and LLM_MODEL)


def llm_status() -> dict:
    """返回给前端展示的 LLM 配置状态，不泄露密钥内容。"""
    return {
        "configured": llm_configured(),
        "base_url": LLM_BASE_URL,
        "model": LLM_MODEL,
        "api_key_set": bool(LLM_API_KEY),
    }
