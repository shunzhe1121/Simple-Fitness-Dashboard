"""Agent 工具集。

工具按职责分三组：
    数据类  读写 SQLite 中的饮食、训练、身体记录
    设置类  个人资料与目标（含 TDEE 推算）
    界面类  返回前端动作指令，驱动页面跳转

删除是唯一被刻意做成两步的操作：request_delete 只登记待确认队列
并把候选条目回给用户看，真正落库要等前端点确认后调 API 执行。
"""

import json
from typing import List, Optional

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import nutrition, parser, repository, utils

# 会改动数据的工具，调用后需要通知前端刷新
MUTATING_TOOLS = {
    "record_diet",
    "record_workout",
    "record_body",
    "import_pasted_template",
    "modify_record",
    "save_profile",
    "compute_goals",
}

# 前端可跳转的视图
VIEWS = {
    "today": "今日总览",
    "diet": "饮食记录",
    "workout": "训练记录",
    "body": "身体数据",
    "stats": "统计分析",
    "settings": "设置",
}


def _ok(message: str, **extra) -> str:
    """统一的成功返回，压成紧凑 JSON 减少 token 占用。"""
    payload = {"ok": True, "message": message}
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


def _fail(message: str) -> str:
    """统一的失败返回，让模型能读懂原因并自行纠正。"""
    return json.dumps({"ok": False, "error": message}, ensure_ascii=False)


# ---------------------------------------------------------------- 参数模型


class DietItem(BaseModel):
    """一条饮食记录。"""

    food_name: str = Field(description="食物名称，例如 米饭、鸡胸肉")
    amount: Optional[str] = Field(
        default=None, description="分量，保留单位，例如 150g、一碗、两个"
    )
    calories: Optional[float] = Field(default=None, description="该分量的总热量，千卡")
    protein: Optional[float] = Field(default=None, description="蛋白质克数")
    fat: Optional[float] = Field(default=None, description="脂肪克数")
    carbs: Optional[float] = Field(default=None, description="碳水克数")
    meal_type: Optional[str] = Field(
        default=None, description="餐次，取 早餐/午餐/晚餐/加餐 之一"
    )
    date: Optional[str] = Field(
        default=None, description="日期，支持 今天/昨天/YYYY-MM-DD，留空按今天"
    )
    note: Optional[str] = Field(default=None, description="备注")


# ---------------------------------------------------------------- 数据类工具


@tool
def record_diet(records: List[DietItem]) -> str:
    """记录饮食。适用于用户口语描述吃了什么，例如「中午两个鸡蛋一碗粥」。

    用户没给营养数据时，你要根据常见食物成分自行估算卡路里和三大宏量，
    按实际分量估算而不是每 100g 的值。一次可以传多条。
    如果用户粘贴的是带 ### 的模板文本，改用 import_pasted_template。
    """
    try:
        payload = [item.model_dump() for item in records]
        for item in payload:
            item["source"] = "estimate"
        saved = repository.add_records("diet", payload)
    except repository.RepositoryError as error:
        return _fail(str(error))

    total = sum(row["calories"] or 0 for row in saved)
    lines = [repository.describe_record("diet", row) for row in saved]
    return _ok(
        f"已记录 {len(saved)} 条饮食，合计约 {total:.0f} 千卡",
        records=lines,
    )


@tool
def record_workout(
    category: str,
    duration_min: Optional[float] = None,
    calories: Optional[float] = None,
    date: Optional[str] = None,
    note: Optional[str] = None,
) -> str:
    """记录一次训练。适用于「今天练胸 40 分钟消耗 300 卡」这类描述。

    参数说明：
        category      训练部位或类型，如 胸、背、腿、肩、臂、核心、有氧
        duration_min  时长，分钟
        calories      消耗热量，千卡。用户说了就填，没说就留空，不要自己编
        date          日期，支持 今天/昨天/YYYY-MM-DD，留空按今天
        note          备注
    """
    try:
        saved = repository.add_record(
            "workout",
            {
                "category": category,
                "duration_min": duration_min,
                "calories": calories,
                "date": date,
                "note": note,
            },
        )
    except repository.RepositoryError as error:
        return _fail(str(error))

    return _ok(
        "已记录训练：" + repository.describe_record("workout", saved),
        record_id=saved["id"],
    )


@tool
def record_body(
    weight: Optional[float] = None,
    body_fat: Optional[float] = None,
    waist: Optional[float] = None,
    date: Optional[str] = None,
    note: Optional[str] = None,
) -> str:
    """记录身体数据。适用于「我今天体重 73kg」这类描述。

    参数说明：
        weight    体重 kg
        body_fat  体脂率百分数，只填数字
        waist     腰围 cm
        date      日期，支持 今天/昨天/YYYY-MM-DD，留空按今天
        note      备注
    """
    if weight is None and body_fat is None and waist is None:
        return _fail("体重、体脂、腰围至少要给一个")

    try:
        saved = repository.add_record(
            "body",
            {
                "weight": weight,
                "body_fat": body_fat,
                "waist": waist,
                "date": date,
                "note": note,
            },
        )
    except repository.RepositoryError as error:
        return _fail(str(error))

    return _ok(
        "已记录身体数据：" + repository.describe_record("body", saved),
        record_id=saved["id"],
    )


@tool
def import_pasted_template(text: str, date: Optional[str] = None) -> str:
    """解析用户粘贴的豆包模板文本并入库。

    文本特征是含有 ### 分隔和「食物: xxx」「卡路里: xxx」这类键值对。
    解析走本地规则，不要自己动手拆文本，直接把原文整段传进来。
    如果返回里有 unparsed 内容，再由你判断怎么补救。
    """
    parsed = parser.parse(text, default_date=date)

    saved_counts: dict = {}
    lines: list = []
    for record_type in ("diet", "workout", "body"):
        items = parsed[record_type]
        if not items:
            continue
        try:
            saved = repository.add_records(record_type, items)
        except repository.RepositoryError as error:
            return _fail(str(error))
        saved_counts[record_type] = len(saved)
        lines.extend(repository.describe_record(record_type, row) for row in saved)

    if not saved_counts:
        return _fail(
            "没能从这段文本里解析出记录。"
            + ("提示：" + "；".join(parsed["warnings"]) if parsed["warnings"] else "")
        )

    total_calories = sum(row["calories"] or 0 for row in parsed["diet"])
    summary = "、".join(
        f"{repository.RECORD_TYPES[k]['label']} {v} 条" for k, v in saved_counts.items()
    )
    return _ok(
        f"已入库 {summary}，饮食合计约 {total_calories:.0f} 千卡",
        records=lines,
        warnings=parsed["warnings"] or None,
        unparsed=parsed["unparsed"] or None,
    )


@tool
def query_records(
    record_type: str,
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 30,
) -> str:
    """查询记录明细，用于回答「我昨天吃了什么」「上周练了几次」这类问题。

    参数说明：
        record_type  取 diet / workout / body 之一
        date         查单日
        date_from    区间起始，与 date_to 配合使用
        date_to      区间结束
        limit        最多返回条数
    """
    try:
        rows = repository.list_records(
            record_type,
            date=date,
            date_from=date_from,
            date_to=date_to,
            limit=limit,
        )
    except repository.RepositoryError as error:
        return _fail(str(error))

    if not rows:
        return _ok("这个范围内没有记录", records=[])

    return _ok(
        f"查到 {len(rows)} 条记录",
        records=[repository.describe_record(record_type, row) for row in rows],
    )


@tool
def daily_summary(date: Optional[str] = None) -> str:
    """查某一天的汇总：饮食合计、训练合计、体重，以及与目标的差距。

    参数 date 支持 今天/昨天/YYYY-MM-DD，留空按今天。
    """
    data = repository.daily_summary(date)
    diet = data["diet"]["total"]
    workout = data["workout"]["total"]
    goals = data["goals"] or {}

    result = {
        "date": data["date"],
        "摄入千卡": round(diet["calories"], 1),
        "蛋白质": round(diet["protein"], 1),
        "脂肪": round(diet["fat"], 1),
        "碳水": round(diet["carbs"], 1),
        "饮食条数": diet["count"],
        "训练分钟": round(workout["duration_min"], 1),
        "训练消耗千卡": round(workout["calories"], 1),
        "训练条数": workout["count"],
        "体重": (data["body"] or {}).get("weight"),
        "目标千卡": goals.get("daily_calories"),
        "目标蛋白质": goals.get("protein_g"),
    }
    return _ok("单日汇总", summary=result)


@tool
def range_stats(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    days: Optional[int] = None,
) -> str:
    """查一段时间的统计：均值、总量、训练天数、体重变化、目标差距。

    可以直接给 days（例如 7 表示最近七天），也可以给明确的起止日期。
    做趋势分析或回答「这周怎么样」时用这个工具。
    """
    if days:
        start, end = utils.date_range(days, date_to)
    else:
        start = date_from or utils.date_range(7)[0]
        end = date_to or utils.today_str()

    data = repository.range_stats(start, end)
    averages = data["averages"]
    totals = data["totals"]
    macros = nutrition.macro_calories(
        averages["protein"], averages["fat"], averages["carbs"]
    )

    return _ok(
        f"{data['date_from']} 到 {data['date_to']} 的统计",
        averages=averages,
        totals=totals,
        macro_share={
            "蛋白质占比": macros["protein_share"],
            "脂肪占比": macros["fat_share"],
            "碳水占比": macros["carbs_share"],
        },
        category_minutes=data["category_minutes"],
        goal_gap=data["goal_gap"],
        weight_series=[v for v in data["series"]["weight"] if v is not None],
    )


@tool
def modify_record(record_type: str, record_id: int, fields: dict) -> str:
    """修改一条已有记录。

    参数说明：
        record_type  取 diet / workout / body 之一
        record_id    记录 id，不确定时先用 query_records 查
        fields       要改的字段与新值，例如 {"calories": 600}
    """
    try:
        updated = repository.update_record(record_type, record_id, fields)
    except repository.RepositoryError as error:
        return _fail(str(error))

    return _ok("已更新：" + repository.describe_record(record_type, updated))


@tool
def request_delete(
    record_type: str,
    record_ids: Optional[List[int]] = None,
    date: Optional[str] = None,
    keyword: Optional[str] = None,
) -> str:
    """请求删除记录。这一步不会真的删除，只是列出候选条目等用户确认。

    可以直接给 record_ids，也可以给 date 和 keyword 让工具筛选。
    结果会显示成确认卡片，用户点确认后才落库，所以你只需要告诉他
    准备删哪几条、等他确认即可，不要反复调用本工具。

    参数说明：
        record_type  取 diet / workout / body 之一
        record_ids   明确的记录 id 列表
        date         按日期筛选
        keyword      按食物名或训练部位模糊筛选
    """
    try:
        if record_ids:
            rows = [
                row
                for row in (
                    repository.get_record(record_type, rid) for rid in record_ids
                )
                if row and not row.get("deleted_at")
            ]
        else:
            rows = repository.list_records(record_type, date=date, limit=100)
            if keyword:
                needle = keyword.strip()
                key = "food_name" if record_type == "diet" else "category"
                rows = [row for row in rows if needle in str(row.get(key) or "")]
    except repository.RepositoryError as error:
        return _fail(str(error))

    if not rows:
        return _fail("没找到符合条件的记录，确认一下日期或关键词")

    descriptions = [repository.describe_record(record_type, row) for row in rows]
    label = repository.RECORD_TYPES[record_type]["label"]
    summary = f"准备删除 {len(rows)} 条{label}记录"

    pending = repository.create_pending(
        "delete",
        record_type,
        {"ids": [row["id"] for row in rows]},
        summary,
    )

    return _ok(
        summary + "，已生成确认卡片，等用户点击确认后才会真正删除",
        pending_id=pending["id"],
        summary=summary,
        records=descriptions,
        need_confirm=True,
    )


# ---------------------------------------------------------------- 设置类工具


@tool
def get_profile_and_goals() -> str:
    """读取个人资料和当前目标设定。做分析或算 TDEE 之前先看一眼。"""
    profile = repository.get_profile()
    goals = repository.get_goals()
    missing = nutrition.missing_profile_fields(profile)
    return _ok(
        "当前资料与目标",
        profile={
            "身高": profile.get("height"),
            "年龄": profile.get("age"),
            "性别": profile.get("gender"),
            "活动水平": profile.get("activity_level"),
            "目标类型": profile.get("goal_type"),
            "最近体重": profile.get("latest_weight"),
        },
        goals=goals,
        missing=missing or None,
    )


@tool
def save_profile(
    height: Optional[float] = None,
    birth_year: Optional[int] = None,
    age: Optional[int] = None,
    gender: Optional[str] = None,
    activity_level: Optional[str] = None,
    goal_type: Optional[str] = None,
) -> str:
    """保存个人资料。

    参数说明：
        height          身高 cm
        birth_year      出生年份
        age             年龄，会自动换算成出生年份
        gender          男 或 女
        activity_level  久坐/轻度/中度/高强度/极高
        goal_type       减脂/维持/增肌
    """
    from datetime import date as _date

    fields = {
        "height": height,
        "birth_year": birth_year,
        "gender": gender,
        "activity_level": (
            nutrition.normalize_activity(activity_level) if activity_level else None
        ),
        "goal_type": nutrition.normalize_goal(goal_type) if goal_type else None,
    }
    if birth_year is None and age:
        fields["birth_year"] = _date.today().year - int(age)

    fields = {key: value for key, value in fields.items() if value is not None}
    if not fields:
        return _fail("没有需要保存的资料字段")

    profile = repository.update_profile(fields)
    return _ok(
        "个人资料已更新",
        profile={
            "身高": profile.get("height"),
            "年龄": profile.get("age"),
            "性别": profile.get("gender"),
            "活动水平": profile.get("activity_level"),
            "目标类型": profile.get("goal_type"),
        },
    )


@tool
def compute_goals(
    weight: Optional[float] = None,
    height: Optional[float] = None,
    age: Optional[int] = None,
    gender: Optional[str] = None,
    activity_level: Optional[str] = None,
    goal_type: Optional[str] = None,
    target_weight: Optional[float] = None,
    workout_days_per_week: Optional[int] = None,
) -> str:
    """根据身体数据推算 BMR、TDEE 和每日摄入目标，并存入设置。

    没传的参数会自动从已有资料和最近一次体重记录里补齐。
    资料不全时会告诉你缺什么，你去问用户，别自己假设数值。
    """
    profile = repository.get_profile()

    weight = weight or profile.get("latest_weight")
    height = height or profile.get("height")
    age = age or profile.get("age")
    gender = gender or profile.get("gender")
    activity_level = activity_level or profile.get("activity_level")
    goal_type = goal_type or profile.get("goal_type")

    missing = []
    if not weight:
        missing.append("体重")
    if not height:
        missing.append("身高")
    if not age:
        missing.append("年龄")
    if not gender:
        missing.append("性别")
    if missing:
        return _fail("缺少这些信息，先问用户：" + "、".join(missing))

    plan = nutrition.calc_plan(
        weight=weight,
        height=height,
        age=age,
        gender=gender,
        activity_level=activity_level,
        goal_type=goal_type,
    )

    # 顺手把用到的资料一起持久化，下次不用重复问
    repository.update_profile(
        {
            "height": height,
            "gender": plan["gender"],
            "activity_level": plan["activity_level"],
            "goal_type": plan["goal_type"],
        }
    )
    repository.update_goals(
        {
            "bmr": plan["bmr"],
            "tdee": plan["tdee"],
            "daily_calories": plan["daily_calories"],
            "protein_g": plan["protein_g"],
            "fat_g": plan["fat_g"],
            "carbs_g": plan["carbs_g"],
            "target_weight": target_weight,
            "workout_days_per_week": workout_days_per_week,
        }
    )

    return _ok(plan["explain"], plan=plan)


# ---------------------------------------------------------------- 界面类工具


@tool
def navigate_ui(
    view: str,
    date: Optional[str] = None,
    days: Optional[int] = None,
) -> str:
    """切换网页界面到指定页面。用户说「分析饮食」「看统计」「打开设置」时调用。

    参数说明：
        view  取 today / diet / workout / body / stats / settings 之一
              分析类需求用 stats，看某天明细用 diet 或 workout
        date  需要定位到具体某天时传，支持 今天/昨天/YYYY-MM-DD
        days  统计页的时间跨度，例如 7 表示最近七天
    """
    key = (view or "").strip().lower()
    if key not in VIEWS:
        return _fail(f"未知页面 {view}，可选：{'、'.join(VIEWS)}")

    action = {"type": "navigate", "view": key}
    if date:
        action["date"] = utils.resolve_date(date)
    if days:
        action["days"] = int(days)

    return _ok(f"已切换到{VIEWS[key]}", ui_action=action)


# 供 graph 绑定的完整工具列表
TOOLS = [
    record_diet,
    record_workout,
    record_body,
    import_pasted_template,
    query_records,
    daily_summary,
    range_stats,
    modify_record,
    request_delete,
    get_profile_and_goals,
    save_profile,
    compute_goals,
    navigate_ui,
]
