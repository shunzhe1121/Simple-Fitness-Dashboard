"""豆包模板文本解析器。

解析走纯规则，不消耗 LLM 额度也不依赖 API：
按 ### 分块，块内按「键: 值」提取，字段名做别名归一化。
识别不出的块会原样回传，交给上层决定是否让 Agent 兜底理解。

虽然目前只有饮食需要走模板，解析器仍然同时认识训练和身体两类块，
这样以后模板扩展或粘贴到旧格式文本时不会直接失败。
"""

from __future__ import annotations

import re

from . import utils

# 字段别名表：把各种可能的写法映射到数据库字段
_ALIASES: dict[str, str] = {
    # 通用
    "类型": "_type",
    "分类": "_type",
    "type": "_type",
    "日期": "date",
    "date": "date",
    "备注": "note",
    "说明": "note",
    "note": "note",
    # 饮食
    "餐次": "meal_type",
    "餐": "meal_type",
    "meal": "meal_type",
    "食物": "food_name",
    "食品": "food_name",
    "名称": "food_name",
    "菜名": "food_name",
    "food": "food_name",
    "name": "food_name",
    "分量": "amount",
    "份量": "amount",
    "数量": "amount",
    "克数": "amount",
    "amount": "amount",
    "portion": "amount",
    "卡路里": "calories",
    "热量": "calories",
    "能量": "calories",
    "千卡": "calories",
    "calories": "calories",
    "kcal": "calories",
    "蛋白质": "protein",
    "蛋白": "protein",
    "protein": "protein",
    "脂肪": "fat",
    "fat": "fat",
    "碳水": "carbs",
    "碳水化合物": "carbs",
    "carbs": "carbs",
    "carbohydrate": "carbs",
    # 训练
    "部位": "category",
    "训练部位": "category",
    "category": "category",
    "项目": "_exercise",
    "动作": "_exercise",
    "运动": "_exercise",
    "exercise": "_exercise",
    "时长": "duration_min",
    "时间": "duration_min",
    "分钟": "duration_min",
    "duration": "duration_min",
    # 身体
    "体重": "weight",
    "weight": "weight",
    "体脂": "body_fat",
    "体脂率": "body_fat",
    "body_fat": "body_fat",
    "腰围": "waist",
    "waist": "waist",
}

# 餐次归一化
_MEAL_ALIASES = {
    "早餐": "早餐",
    "早": "早餐",
    "早饭": "早餐",
    "breakfast": "早餐",
    "午餐": "午餐",
    "中餐": "午餐",
    "午": "午餐",
    "午饭": "午餐",
    "lunch": "午餐",
    "晚餐": "晚餐",
    "晚": "晚餐",
    "晚饭": "晚餐",
    "dinner": "晚餐",
    "加餐": "加餐",
    "零食": "加餐",
    "夜宵": "加餐",
    "snack": "加餐",
}

# 表示「没有数据」的占位值，出现即视为字段缺失
_EMPTY_VALUES = {
    "",
    "-",
    "--",
    "无",
    "未知",
    "不详",
    "不确定",
    "n/a",
    "na",
    "null",
    "none",
    "待补充",
}

_BLOCK_SPLIT = re.compile(r"#{3,}")
_FENCE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$", re.MULTILINE)
_KEY_VALUE = re.compile(r"^\s*([^:：]{1,20})[:：]\s*(.*)$")

# 汇总行判据。「早+午合计」「全天共计」这类行不是独立记录，
# 一旦入库会让全天热量翻倍，所以在服务端直接丢弃。
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


def _is_summary(name: str | None) -> bool:
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


def _clean_text(text: str) -> str:
    """去掉 markdown 代码围栏和多余空白。"""
    return _FENCE.sub("", (text or "").replace("\r\n", "\n").replace("\r", "\n")).strip()


def _split_blocks(text: str) -> list[str]:
    """把整段文本切成一条条记录块。

    优先按 ### 切分；没有 ### 时退化为按空行切分，
    仍然切不出来就把整段当成一块。
    """
    if "###" in text:
        blocks = [block.strip() for block in _BLOCK_SPLIT.split(text)]
    else:
        blocks = [block.strip() for block in re.split(r"\n\s*\n", text)]

    blocks = [block for block in blocks if block]
    return blocks or ([text.strip()] if text.strip() else [])


def _parse_block(block: str) -> dict:
    """把一个块解析成「字段 → 原始值」的字典。"""
    fields: dict[str, str] = {}
    for line in block.split("\n"):
        matched = _KEY_VALUE.match(line)
        if not matched:
            continue
        raw_key = matched.group(1).strip().strip("-*·•").strip()
        raw_value = matched.group(2).strip()
        key = _ALIASES.get(raw_key) or _ALIASES.get(raw_key.lower())
        if not key:
            continue
        if raw_value.lower() in _EMPTY_VALUES:
            continue
        fields[key] = raw_value
    return fields


def _infer_type(fields: dict) -> str | None:
    """判断这一块属于哪类记录。

    优先看显式的「类型」字段，没有就按出现的字段特征推断。
    """
    declared = (fields.get("_type") or "").strip()
    if declared:
        if any(word in declared for word in ("饮食", "食物", "餐", "diet", "food")):
            return "diet"
        if any(word in declared for word in ("训练", "运动", "健身", "workout")):
            return "workout"
        if any(word in declared for word in ("身体", "体重", "体测", "body")):
            return "body"

    if fields.get("food_name"):
        return "diet"
    if fields.get("category") or fields.get("_exercise") or fields.get("duration_min"):
        return "workout"
    if fields.get("weight") or fields.get("body_fat") or fields.get("waist"):
        return "body"
    return None


def _build_diet(fields: dict, default_date: str) -> dict:
    """组装一条饮食记录。"""
    meal_raw = (fields.get("meal_type") or "").strip()
    meal = _MEAL_ALIASES.get(meal_raw) or _MEAL_ALIASES.get(meal_raw.lower()) or (
        meal_raw or None
    )

    return {
        "date": utils.resolve_date(fields.get("date"), default_today=False) or default_date,
        "meal_type": meal,
        "food_name": fields.get("food_name"),
        "amount": fields.get("amount"),
        "calories": utils.to_float(fields.get("calories")),
        "protein": utils.to_float(fields.get("protein")),
        "fat": utils.to_float(fields.get("fat")),
        "carbs": utils.to_float(fields.get("carbs")),
        "source": "template",
        "note": fields.get("note"),
    }


def _build_workout(fields: dict, default_date: str) -> dict:
    """组装一条训练记录。

    训练走最简结构：部位 + 时长 + 消耗。
    模板里如果写了具体项目，并入备注保留信息。
    """
    exercise = fields.get("_exercise")
    category = fields.get("category") or exercise or "未分类"

    notes = [fields.get("note")]
    if exercise and fields.get("category"):
        notes.insert(0, f"项目：{exercise}")
    note = " / ".join(n for n in notes if n) or None

    return {
        "date": utils.resolve_date(fields.get("date"), default_today=False) or default_date,
        "category": category,
        "duration_min": utils.to_float(fields.get("duration_min")),
        "calories": utils.to_float(fields.get("calories")),
        "note": note,
    }


def _build_body(fields: dict, default_date: str) -> dict:
    """组装一条身体数据记录。"""
    return {
        "date": utils.resolve_date(fields.get("date"), default_today=False) or default_date,
        "weight": utils.to_float(fields.get("weight")),
        "body_fat": utils.to_float(fields.get("body_fat")),
        "waist": utils.to_float(fields.get("waist")),
        "note": fields.get("note"),
    }


def parse(text: str, default_date: str | None = None) -> dict:
    """解析粘贴文本，返回按类型分组的记录。

    参数:
        text: 待解析的原始文本
        default_date: 块内没写日期时使用的日期，默认取今天

    返回:
        {"diet": [...], "workout": [...], "body": [...],
         "unparsed": [...], "warnings": [...]}
    """
    day = utils.resolve_date(default_date) or utils.today_str()
    cleaned = _clean_text(text)

    result: dict = {
        "diet": [],
        "workout": [],
        "body": [],
        "unparsed": [],
        "warnings": [],
    }

    if not cleaned:
        result["warnings"].append("粘贴内容为空")
        return result

    for block in _split_blocks(cleaned):
        fields = _parse_block(block)
        if not fields:
            result["unparsed"].append(block)
            continue

        record_type = _infer_type(fields)
        if record_type == "diet":
            record = _build_diet(fields, day)
            if not record["food_name"]:
                result["unparsed"].append(block)
                continue
            if _is_summary(record["food_name"]):
                result["warnings"].append(f"已跳过汇总行：{record['food_name']}")
                continue
            result["diet"].append(record)
        elif record_type == "workout":
            record = _build_workout(fields, day)
            if _is_summary(record["category"]):
                result["warnings"].append(f"已跳过汇总行：{record['category']}")
                continue
            result["workout"].append(record)
        elif record_type == "body":
            record = _build_body(fields, day)
            if all(record[key] is None for key in ("weight", "body_fat", "waist")):
                result["unparsed"].append(block)
                continue
            result["body"].append(record)
        else:
            result["unparsed"].append(block)

    total = len(result["diet"]) + len(result["workout"]) + len(result["body"])
    if total == 0:
        result["warnings"].append(
            "没能从文本里识别出任何记录，检查一下是否漏了 ### 分隔或字段名写法"
        )
    if result["unparsed"]:
        result["warnings"].append(f"有 {len(result['unparsed'])} 段内容没能识别")

    # 缺少营养素数据时给个提示，避免统计页出现空洞而不知原因
    incomplete = [r["food_name"] for r in result["diet"] if r["calories"] is None]
    if incomplete:
        result["warnings"].append(
            "以下食物没有卡路里数据：" + "、".join(incomplete[:5])
        )

    return result


# 提供给前端「一键复制」的豆包提示词。
# 日期不交给模型写，由后端按粘贴时刻自动补，比让模型输出「今天」可靠。
DOUBAO_PROMPT = """识别图片中的食物，严格按下面格式输出，不要加任何解释或前后缀文字。

###
餐次: 午餐
食物: 米饭
分量: 150g
卡路里: 174
蛋白质: 3.5
脂肪: 0.4
碳水: 38.5
###

规则：
1. 每种食物独立包在一组 ### 之间，多种食物就输出多组
2. 数值只写数字不带单位，分量保留单位
3. 蛋白质、脂肪、碳水必须按图中实际分量估算并输出（参考常见食物营养表），
   不确定时给合理估算值，不要省略整行；只有完全无法估计的菜式才可省略
4. 其他无法确定的字段（如餐次）直接省略整行，不要写"未知""无""0"
5. 营养素按实际分量计算，不是每 100g 的值"""
