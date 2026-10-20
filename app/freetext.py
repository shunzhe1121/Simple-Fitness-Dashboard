"""自由文本分层解析。

「粘贴识图输出的文本」不一定严格符合模板：用户粘的可能是豆包的原始输出、
带着解释性文字，甚至是自己打字描述的一顿饭。这里做两级解析：

1. 本地规则层（parser.parse）——零 token。文本带 ### 和「键: 值」特征时
   直接命中，绝大多数识图输出都在这一层解决。
2. LLM 结构化层——只把本地解析剩下的片段交给模型，用最短的提示词换成
   结构化 JSON。命中率低但成本也低：一次几百 token。

设计取舍：刻意不走 /api/agent/chat。Agent 循环每次都要带上千 token 的
系统提示词加对话历史，纯粹为了「粘贴 → 入库」付这个钱不划算；专门的入口
只发一段提示词，成本差一个数量级。Agent 侧另有 parse_pasted_text 工具
复用同一套逻辑，保证两条路径口径一致。
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

import requests

from . import config, parser, utils

# LLM 提取结果缓存：同一段文本重复粘贴不重复付费。
# 进程内字典足够——识图输出通常当场就入库了，跨重启的重复粘贴很少见。
_CACHE: dict[str, dict] = {}
_CACHE_LIMIT = 64

# 模板特征：### 分隔 + 「键: 值」行。用于判断能否走零成本的本地层。
_TEMPLATE_HINT = re.compile(r"#{3,}")
_KEY_VALUE_HINT = re.compile(r"^\s*[^:：\n]{1,20}[:：]", re.MULTILINE)

# LLM 偶发把 JSON 包在 ```json 围栏里，或前后带一句解释
_JSON_FENCE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$", re.MULTILINE)
_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)

# 汇总行判据。提示词里已经要求模型忽略这类行，但模型不一定听话，
# 而它一旦把「早+午合计」当成一条记录，全天热量就会翻倍，必须在服务端兜住。
# 判据必须收紧：真实食物名里也可能出现「合计」二字（如「轻食沙拉
# （…其余配菜合计 200g）」），按关键词搜索会误伤整条记录，
# 所以要求汇总词在末尾、前面的修饰极短、且名称不含分量。
_SUMMARY_WHOLE = re.compile(
    r"^(合计|共计|总计|汇总|小结|小计|全天|一天|一日|总量|总和|total)$",
    re.IGNORECASE,
)
_SUMMARY_TAIL = re.compile(r"(合计|共计|总计|汇总|小结|小计)$", re.IGNORECASE)
_SUMMARY_HEAD = re.compile(r"^(合计|共计|总计|汇总|小结|小计)", re.IGNORECASE)
_AMOUNT_HINT = re.compile(
    r"\d+\s*(g|kg|ml|克|千克|毫升|个|只|片|块|碗|杯|根|颗|勺)"
)

_EXTRACT_PROMPT = """你是饮食记录结构化器。把用户给的文本解析成 JSON，只输出 JSON 本身，
不要解释、不要代码围栏、不要前后缀。

输出格式：
{"diet":[{"food_name":"","meal_type":"","amount":"","calories":0,"protein":0,"fat":0,"carbs":0}],
 "workout":[{"category":"","duration_min":0,"calories":0}],
 "body":[{"weight":0,"body_fat":0,"waist":0}]}

规则：
1. 字段名必须与上面完全一致；没有的字段省略整个键，不要写 null 或 "未知"
2. 数值只写数字不带单位；热量单位千卡，营养素单位克，体重千克，体脂百分数
3. 营养素按文本给出的实际分量，不确定就给常见食物的合理估算值，不要留空
4. 「早+午合计」「全天合计」这类汇总行一律忽略，只保留单条记录
5. 训练只记部位、时长、消耗三项；用户没说消耗就省略 calories
6. 完全找不到可记录内容时输出 {"diet":[],"workout":[],"body":[]}"""


def looks_like_template(text: str) -> bool:
    """文本是否带模板特征（### 分隔 + 键值对）。"""
    cleaned = (text or "").strip()
    if not cleaned:
        return False
    return bool(_TEMPLATE_HINT.search(cleaned) and _KEY_VALUE_HINT.search(cleaned))


def _cache_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _cache_get(text: str) -> dict | None:
    return _CACHE.get(_cache_key(text))


def _cache_put(text: str, value: dict) -> None:
    if len(_CACHE) >= _CACHE_LIMIT:
        # 简单淘汰：清掉最早插入的一批，避免无界增长
        for stale in list(_CACHE.keys())[: _CACHE_LIMIT // 2]:
            _CACHE.pop(stale, None)
    _CACHE[_cache_key(text)] = value


def _number(value: Any) -> float | None:
    """把 LLM 返回的值收敛成 float，接受 "174"、"174.5"、"约200" 这类写法。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    matched = re.search(r"-?\d+(?:\.\d+)?", str(value))
    return float(matched.group()) if matched else None


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _is_summary(name: str | None) -> bool:
    """这一条是不是汇总行。命中就丢弃，避免全天热量被重复累加。"""
    if not name:
        return False
    text = name.strip()
    if _SUMMARY_WHOLE.match(text):
        return True
    if _SUMMARY_HEAD.match(text) and len(text) <= 10:
        return True
    if not _SUMMARY_TAIL.search(text):
        return False
    head = _SUMMARY_TAIL.sub("", text)
    return bool(head) and len(head) <= 8 and not _AMOUNT_HINT.search(text)


def _diet_record(raw: dict, day: str) -> dict:
    return {
        "date": day,
        "meal_type": _clean_str(raw.get("meal_type")),
        "food_name": _clean_str(raw.get("food_name")),
        "amount": _clean_str(raw.get("amount")),
        "calories": _number(raw.get("calories")),
        "protein": _number(raw.get("protein")),
        "fat": _number(raw.get("fat")),
        "carbs": _number(raw.get("carbs")),
        "source": "llm",
        "note": None,
    }


def _workout_record(raw: dict, day: str) -> dict:
    return {
        "date": day,
        "category": _clean_str(raw.get("category")) or "未分类",
        "duration_min": _number(raw.get("duration_min")),
        "calories": _number(raw.get("calories")),
        "note": None,
    }


def _body_record(raw: dict, day: str) -> dict:
    return {
        "date": day,
        "weight": _number(raw.get("weight")),
        "body_fat": _number(raw.get("body_fat")),
        "waist": _number(raw.get("waist")),
        "note": None,
    }


def _extract_with_llm(text: str, day: str) -> tuple[dict, str | None]:
    """调 LLM 把自由文本结构化。

    返回 (按类型分组的记录, 错误信息)。失败不抛异常，让上层继续用本地结果。
    """
    if not config.llm_configured():
        return {"diet": [], "workout": [], "body": []}, (
            "LLM 未配置，只能用本地规则解析。在 .env 填好 "
            "LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 后可解析任意文本"
        )

    cached = _cache_get(text)
    if cached is not None:
        return cached, None

    payload = {
        "model": config.LLM_MODEL,
        "temperature": 0,
        "max_tokens": 1024,
        "messages": [
            {"role": "system", "content": _EXTRACT_PROMPT},
            {"role": "user", "content": text},
        ],
    }

    try:
        response = requests.post(
            f"{config.LLM_BASE_URL.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
    except requests.RequestException as error:
        return {"diet": [], "workout": [], "body": []}, f"LLM 请求失败：{error}"

    if response.status_code != 200:
        snippet = (response.text or "")[:200]
        return {"diet": [], "workout": [], "body": []}, (
            f"LLM 返回 {response.status_code}：{snippet}"
        )

    try:
        content = response.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        return {"diet": [], "workout": [], "body": []}, f"LLM 返回结构异常：{error}"

    records = _records_from_json(content, day)
    if records is None:
        return {"diet": [], "workout": [], "body": []}, "LLM 输出的不是合法 JSON"

    _cache_put(text, records)
    return records, None


def _records_from_json(content: str, day: str) -> dict | None:
    """把 LLM 输出收敛成与 parser 一致的记录结构。"""
    if isinstance(content, list):  # 少数模型返回分节内容
        content = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    text = _JSON_FENCE.sub("", str(content or "")).strip()
    matched = _JSON_OBJECT.search(text)
    if not matched:
        return None

    try:
        data = json.loads(matched.group())
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    result: dict[str, list] = {"diet": [], "workout": [], "body": []}

    for raw in data.get("diet") or []:
        if not isinstance(raw, dict):
            continue
        record = _diet_record(raw, day)
        if record["food_name"] and not _is_summary(record["food_name"]):
            result["diet"].append(record)

    for raw in data.get("workout") or []:
        if not isinstance(raw, dict):
            continue
        record = _workout_record(raw, day)
        if not _is_summary(record["category"]):
            result["workout"].append(record)

    for raw in data.get("body") or []:
        if not isinstance(raw, dict):
            continue
        record = _body_record(raw, day)
        if any(record[key] is not None for key in ("weight", "body_fat", "waist")):
            result["body"].append(record)

    return result


def parse_tiered(text: str, default_date: str | None = None) -> dict:
    """分层解析自由文本。

    返回 parser.parse 同款结构，另加两个字段：
        tier      "local"（零 token 命中）或 "llm"（调了模型）
        llm_error LLM 层失败的原因，成功时为 None
    """
    day = utils.resolve_date(default_date) or utils.today_str()
    cleaned = (text or "").strip()

    local = parser.parse(cleaned, default_date=day)

    # 本地层已经吃干净了，或者压根没配 LLM，就地返回
    if not local["unparsed"] or not cleaned:
        local["tier"] = "local"
        local["llm_error"] = None
        return local

    # 只把本地解析剩下的片段交给模型，已命中的部分不重复付费
    leftover = "\n\n".join(local["unparsed"])
    extracted, error = _extract_with_llm(leftover, day)

    if error:
        local["tier"] = "local"
        local["llm_error"] = error
        return local

    if not any(extracted.values()):
        # LLM 也没捞到东西，保留本地结果和原始告警
        local["tier"] = "llm"
        local["llm_error"] = None
        local["warnings"].append("AI 兜底解析仍未能识别出剩余内容")
        return local

    for record_type in ("diet", "workout", "body"):
        local[record_type].extend(extracted[record_type])

    # 剩下的 unparsed 已经被 AI 处理过，清掉避免前端重复告警
    local["unparsed"] = []
    local["tier"] = "llm"
    local["llm_error"] = None
    local["warnings"] = [
        w for w in local["warnings"] if "没能识别" not in w
    ]
    return local
