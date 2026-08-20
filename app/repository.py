"""数据访问层。

对外暴露三类记录的增删改查、汇总统计，以及个人资料、目标、
待确认队列和对话历史的读写。所有写入都会归一化日期与数值，
保证 Agent 传进来的口语参数不会污染数据库。
"""

from __future__ import annotations

import json

from . import db, nutrition, utils

# 三类记录的元信息。表名只来自这个字典，不接受外部拼接，
# 因此 SQL 里直接内插表名是安全的。
RECORD_TYPES: dict[str, dict] = {
    "diet": {
        "table": "diet_records",
        "label": "饮食",
        "fields": [
            "date",
            "meal_type",
            "food_name",
            "amount",
            "calories",
            "protein",
            "fat",
            "carbs",
            "source",
            "note",
        ],
        "numeric": ["calories", "protein", "fat", "carbs"],
        "required": ["food_name"],
    },
    "workout": {
        "table": "workout_records",
        "label": "训练",
        "fields": ["date", "category", "duration_min", "calories", "note"],
        "numeric": ["duration_min", "calories"],
        "required": ["category"],
    },
    "body": {
        "table": "body_records",
        "label": "身体",
        "fields": ["date", "weight", "body_fat", "waist", "note"],
        "numeric": ["weight", "body_fat", "waist"],
        "required": [],
    },
}


class RepositoryError(Exception):
    """数据层的业务异常，交由上层转成友好提示。"""


def _meta(record_type: str) -> dict:
    """取记录类型元信息，类型非法时抛业务异常。"""
    meta = RECORD_TYPES.get(record_type)
    if not meta:
        allowed = "、".join(RECORD_TYPES)
        raise RepositoryError(f"未知的记录类型 {record_type}，可选：{allowed}")
    return meta


def _normalize(record_type: str, data: dict) -> dict:
    """按元信息裁剪字段、归一化日期与数值。"""
    meta = _meta(record_type)
    cleaned: dict = {}

    for field in meta["fields"]:
        if field not in data:
            continue
        value = data[field]
        if field == "date":
            cleaned[field] = utils.resolve_date(value)
        elif field in meta["numeric"]:
            cleaned[field] = utils.to_float(value)
        else:
            cleaned[field] = None if value is None else str(value).strip() or None

    cleaned.setdefault("date", utils.today_str())

    for field in meta["required"]:
        if not cleaned.get(field):
            raise RepositoryError(f"{meta['label']}记录缺少必填字段：{field}")

    return cleaned


# ---------------------------------------------------------------- 记录写入


def add_record(record_type: str, data: dict) -> dict:
    """新增一条记录，返回入库后的完整行。"""
    meta = _meta(record_type)
    cleaned = _normalize(record_type, data)
    cleaned["created_at"] = utils.now_str()

    columns = ", ".join(cleaned)
    placeholders = ", ".join("?" for _ in cleaned)
    sql = f"INSERT INTO {meta['table']} ({columns}) VALUES ({placeholders})"
    new_id = db.execute(sql, tuple(cleaned.values()))
    return get_record(record_type, new_id)


def add_records(record_type: str, items: list[dict]) -> list[dict]:
    """批量新增记录，逐条校验，任一条非法即整体失败。"""
    if not items:
        raise RepositoryError("没有可写入的记录")
    return [add_record(record_type, item) for item in items]


def get_record(record_type: str, record_id: int) -> dict | None:
    """按 id 取单条记录，含已软删除的行。"""
    meta = _meta(record_type)
    return db.query_one(f"SELECT * FROM {meta['table']} WHERE id = ?", (record_id,))


def list_records(
    record_type: str,
    date: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int | None = None,
    include_deleted: bool = False,
) -> list[dict]:
    """按日期或日期区间列出记录，默认过滤软删除行。"""
    meta = _meta(record_type)
    conditions: list[str] = []
    params: list = []

    if not include_deleted:
        conditions.append("deleted_at IS NULL")

    if date:
        conditions.append("date = ?")
        params.append(utils.resolve_date(date))
    else:
        if date_from:
            conditions.append("date >= ?")
            params.append(utils.resolve_date(date_from))
        if date_to:
            conditions.append("date <= ?")
            params.append(utils.resolve_date(date_to))

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    tail = f"LIMIT {int(limit)}" if limit else ""
    sql = f"SELECT * FROM {meta['table']} {where} ORDER BY date DESC, id DESC {tail}"
    return db.query(sql, tuple(params))


def update_record(record_type: str, record_id: int, fields: dict) -> dict:
    """局部更新一条记录，只允许改元信息里声明的字段。"""
    meta = _meta(record_type)
    if not get_record(record_type, record_id):
        raise RepositoryError(f"找不到 id={record_id} 的{meta['label']}记录")

    updates: dict = {}
    for field, value in fields.items():
        if field not in meta["fields"]:
            continue
        if field == "date":
            updates[field] = utils.resolve_date(value)
        elif field in meta["numeric"]:
            updates[field] = utils.to_float(value)
        else:
            updates[field] = None if value is None else str(value).strip() or None

    if not updates:
        raise RepositoryError("没有需要更新的字段")

    assignments = ", ".join(f"{field} = ?" for field in updates)
    sql = f"UPDATE {meta['table']} SET {assignments} WHERE id = ?"
    db.execute(sql, (*updates.values(), record_id))
    return get_record(record_type, record_id)


def soft_delete(record_type: str, record_ids: list[int]) -> int:
    """软删除指定记录，返回实际影响的行数。"""
    meta = _meta(record_type)
    ids = [int(i) for i in record_ids]
    if not ids:
        return 0
    placeholders = ", ".join("?" for _ in ids)
    sql = (
        f"UPDATE {meta['table']} SET deleted_at = ? "
        f"WHERE id IN ({placeholders}) AND deleted_at IS NULL"
    )
    return db.execute(sql, (utils.now_str(), *ids))


def restore(record_type: str, record_ids: list[int]) -> int:
    """从回收站恢复记录。"""
    meta = _meta(record_type)
    ids = [int(i) for i in record_ids]
    if not ids:
        return 0
    placeholders = ", ".join("?" for _ in ids)
    sql = f"UPDATE {meta['table']} SET deleted_at = NULL WHERE id IN ({placeholders})"
    return db.execute(sql, tuple(ids))


def list_deleted(record_type: str, limit: int = 50) -> list[dict]:
    """列出回收站里的记录。"""
    meta = _meta(record_type)
    sql = (
        f"SELECT * FROM {meta['table']} WHERE deleted_at IS NOT NULL "
        f"ORDER BY deleted_at DESC LIMIT {int(limit)}"
    )
    return db.query(sql)


def describe_record(record_type: str, row: dict) -> str:
    """把一条记录压成一行文字，用于删除确认和 Agent 回复。"""
    if record_type == "diet":
        parts = [row.get("date"), row.get("meal_type"), row.get("food_name")]
        if row.get("amount"):
            parts.append(str(row["amount"]))
        if row.get("calories") is not None:
            parts.append(f"{utils.round_or_none(row['calories'], 0):g} 千卡")
    elif record_type == "workout":
        parts = [row.get("date"), row.get("category")]
        if row.get("duration_min") is not None:
            parts.append(f"{utils.round_or_none(row['duration_min'], 0):g} 分钟")
        if row.get("calories") is not None:
            parts.append(f"{utils.round_or_none(row['calories'], 0):g} 千卡")
    else:
        parts = [row.get("date")]
        if row.get("weight") is not None:
            parts.append(f"体重 {utils.round_or_none(row['weight'])} kg")
        if row.get("body_fat") is not None:
            parts.append(f"体脂 {utils.round_or_none(row['body_fat'])}%")
        if row.get("waist") is not None:
            parts.append(f"腰围 {utils.round_or_none(row['waist'])} cm")

    text = " · ".join(str(p) for p in parts if p)
    return f"#{row.get('id')} {text}"


# ---------------------------------------------------------------- 汇总统计


def daily_summary(date: str | None = None) -> dict:
    """单日汇总：饮食合计、训练合计、当日身体数据与目标对比。"""
    day = utils.resolve_date(date)

    diet_rows = list_records("diet", date=day)
    workout_rows = list_records("workout", date=day)
    body_rows = list_records("body", date=day)

    diet_total = {
        "calories": sum(r["calories"] or 0 for r in diet_rows),
        "protein": sum(r["protein"] or 0 for r in diet_rows),
        "fat": sum(r["fat"] or 0 for r in diet_rows),
        "carbs": sum(r["carbs"] or 0 for r in diet_rows),
        "count": len(diet_rows),
    }
    workout_total = {
        "duration_min": sum(r["duration_min"] or 0 for r in workout_rows),
        "calories": sum(r["calories"] or 0 for r in workout_rows),
        "count": len(workout_rows),
    }

    # 同一天多次称重时取最后一条
    latest_body = body_rows[0] if body_rows else None

    # 热量缺口 = 每日总消耗(TDEE) − 净摄入(饮食 − 运动消耗)。
    # 有了缺口才知道当天是减脂、持平还是盈余；需要档案完整才能算 TDEE。
    goals = get_goals()
    tdee = goals.get("tdee")
    if tdee is None:
        profile = get_profile()
        if not nutrition.missing_profile_fields(profile):
            plan = nutrition.calc_plan(
                weight=profile["latest_weight"],
                height=profile["height"],
                age=profile["age"],
                gender=profile.get("gender"),
                activity_level=profile.get("activity_level"),
                goal_type=profile.get("goal_type"),
            )
            tdee = plan["tdee"]

    deficit = None
    deficit_band = None
    if tdee is not None:
        net = diet_total["calories"] - workout_total["calories"]
        deficit = round(tdee - net, 1)
        deficit_band = nutrition.classify_deficit(deficit)

    # 有效目标 = 基础目标 + 当日训练消耗。
    # 训练烧掉的热量算进当日预算：净摄入(饮食−运动)仍以基础目标为基准，
    # 等价于毛摄入以「基础目标+训练消耗」为基准，环和状态提示才不会误判超目标。
    daily_calories = goals.get("daily_calories")
    effective_target = None
    if daily_calories:
        effective_target = round(daily_calories + workout_total["calories"], 1)

    return {
        "date": day,
        "tdee": tdee,
        "deficit": deficit,
        "deficit_band": deficit_band,
        "target_calories": effective_target,
        "diet": {"total": diet_total, "records": diet_rows},
        "workout": {"total": workout_total, "records": workout_rows},
        "body": latest_body,
        "goals": goals,
    }


def range_stats(date_from: str, date_to: str) -> dict:
    """区间统计：按天序列 + 区间均值，供图表和分析使用。"""
    start = utils.resolve_date(date_from)
    end = utils.resolve_date(date_to)

    diet_rows = list_records("diet", date_from=start, date_to=end)
    workout_rows = list_records("workout", date_from=start, date_to=end)
    body_rows = list_records("body", date_from=start, date_to=end)

    # 枚举区间内每一天，缺数据的日子补空值，图表才不会错位
    from datetime import date as _date, timedelta

    cursor = _date.fromisoformat(start)
    stop = _date.fromisoformat(end)
    days: list[str] = []
    while cursor <= stop:
        days.append(cursor.isoformat())
        cursor += timedelta(days=1)

    def accumulate(rows: list[dict], field: str) -> dict[str, float]:
        bucket: dict[str, float] = {}
        for row in rows:
            bucket[row["date"]] = bucket.get(row["date"], 0) + (row[field] or 0)
        return bucket

    diet_cal = accumulate(diet_rows, "calories")
    diet_protein = accumulate(diet_rows, "protein")
    diet_fat = accumulate(diet_rows, "fat")
    diet_carbs = accumulate(diet_rows, "carbs")
    workout_cal = accumulate(workout_rows, "calories")
    workout_min = accumulate(workout_rows, "duration_min")

    # 体重按天取最后一次记录
    weight_by_day: dict[str, float] = {}
    for row in sorted(body_rows, key=lambda r: r["id"]):
        if row.get("weight") is not None:
            weight_by_day[row["date"]] = row["weight"]

    series = {
        "days": days,
        "diet_calories": [round(diet_cal.get(d, 0), 1) for d in days],
        "protein": [round(diet_protein.get(d, 0), 1) for d in days],
        "fat": [round(diet_fat.get(d, 0), 1) for d in days],
        "carbs": [round(diet_carbs.get(d, 0), 1) for d in days],
        "workout_calories": [round(workout_cal.get(d, 0), 1) for d in days],
        "workout_minutes": [round(workout_min.get(d, 0), 1) for d in days],
        "weight": [weight_by_day.get(d) for d in days],
    }

    def average(values: list, only_positive: bool = True) -> float | None:
        pool = [v for v in values if v is not None and (v > 0 or not only_positive)]
        return round(sum(pool) / len(pool), 1) if pool else None

    # 训练部位分布，用于饼图
    category_minutes: dict[str, float] = {}
    for row in workout_rows:
        key = row.get("category") or "未分类"
        category_minutes[key] = category_minutes.get(key, 0) + (row["duration_min"] or 0)

    goals = get_goals()
    avg_calories = average(series["diet_calories"])
    target_calories = goals.get("daily_calories")

    return {
        "date_from": start,
        "date_to": end,
        "series": series,
        "averages": {
            "diet_calories": avg_calories,
            "protein": average(series["protein"]),
            "fat": average(series["fat"]),
            "carbs": average(series["carbs"]),
            "workout_calories": average(series["workout_calories"]),
            "workout_minutes": average(series["workout_minutes"]),
            "weight": average(series["weight"], only_positive=False),
        },
        "totals": {
            "diet_calories": round(sum(series["diet_calories"]), 1),
            "workout_calories": round(sum(series["workout_calories"]), 1),
            "workout_minutes": round(sum(series["workout_minutes"]), 1),
            "workout_days": len({r["date"] for r in workout_rows}),
            "diet_records": len(diet_rows),
        },
        "category_minutes": category_minutes,
        "goal_gap": (
            round(avg_calories - target_calories, 1)
            if avg_calories is not None and target_calories
            else None
        ),
        "goals": goals,
    }


# ---------------------------------------------------------------- 资料与目标


def get_profile() -> dict:
    """读取个人资料，附带推算出的年龄和最新体重。"""
    profile = db.query_one("SELECT * FROM user_profile WHERE id = 1") or {}
    profile["age"] = utils.age_from_birth_year(profile.get("birth_year"))
    profile["latest_weight"] = latest_weight()
    return profile


def update_profile(fields: dict) -> dict:
    """更新个人资料。"""
    allowed = ["height", "birth_year", "gender", "activity_level", "goal_type"]
    numeric = {"height"}
    integer = {"birth_year"}

    updates: dict = {}
    for field in allowed:
        if field not in fields:
            continue
        value = fields[field]
        if field in numeric:
            updates[field] = utils.to_float(value)
        elif field in integer:
            updates[field] = utils.to_int(value)
        else:
            updates[field] = None if value is None else str(value).strip() or None

    if updates:
        updates["updated_at"] = utils.now_str()
        assignments = ", ".join(f"{field} = ?" for field in updates)
        db.execute(
            f"UPDATE user_profile SET {assignments} WHERE id = 1",
            tuple(updates.values()),
        )
    return get_profile()


def get_goals() -> dict:
    """读取目标设定。"""
    return db.query_one("SELECT * FROM goals WHERE id = 1") or {}


def update_goals(fields: dict) -> dict:
    """更新目标设定。"""
    allowed = [
        "bmr",
        "tdee",
        "daily_calories",
        "protein_g",
        "fat_g",
        "carbs_g",
        "target_weight",
        "workout_days_per_week",
    ]
    integer = {"workout_days_per_week"}

    updates: dict = {}
    for field in allowed:
        if field not in fields:
            continue
        value = fields[field]
        updates[field] = (
            utils.to_int(value) if field in integer else utils.to_float(value)
        )

    if updates:
        updates["updated_at"] = utils.now_str()
        assignments = ", ".join(f"{field} = ?" for field in updates)
        db.execute(
            f"UPDATE goals SET {assignments} WHERE id = 1", tuple(updates.values())
        )
    return get_goals()


def latest_weight() -> float | None:
    """取最近一次有效体重记录。"""
    row = db.query_one(
        "SELECT weight FROM body_records "
        "WHERE deleted_at IS NULL AND weight IS NOT NULL "
        "ORDER BY date DESC, id DESC LIMIT 1"
    )
    return row["weight"] if row else None


# ---------------------------------------------------------------- 待确认队列


def create_pending(
    action_type: str, record_type: str, payload: dict, summary: str
) -> dict:
    """登记一个待确认操作（目前用于删除的二次确认）。"""
    new_id = db.execute(
        "INSERT INTO pending_actions "
        "(action_type, record_type, payload, summary, status, created_at) "
        "VALUES (?, ?, ?, ?, 'pending', ?)",
        (
            action_type,
            record_type,
            json.dumps(payload, ensure_ascii=False),
            summary,
            utils.now_str(),
        ),
    )
    return get_pending(new_id)


def get_pending(pending_id: int) -> dict | None:
    """按 id 取待确认操作，payload 自动反序列化。"""
    row = db.query_one("SELECT * FROM pending_actions WHERE id = ?", (pending_id,))
    if row:
        row["payload"] = json.loads(row["payload"])
    return row


def list_pending() -> list[dict]:
    """列出所有未处理的待确认操作。"""
    rows = db.query(
        "SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY id DESC"
    )
    for row in rows:
        row["payload"] = json.loads(row["payload"])
    return rows


def resolve_pending(pending_id: int, status: str) -> None:
    """把待确认操作标记为已确认或已取消。"""
    db.execute(
        "UPDATE pending_actions SET status = ? WHERE id = ?", (status, pending_id)
    )


def confirm_pending(pending_id: int) -> dict:
    """执行待确认操作。目前只有删除一种类型。"""
    pending = get_pending(pending_id)
    if not pending:
        raise RepositoryError(f"找不到编号 {pending_id} 的待确认操作")
    if pending["status"] != "pending":
        raise RepositoryError(f"编号 {pending_id} 的操作已处理过了")

    if pending["action_type"] != "delete":
        raise RepositoryError(f"暂不支持的操作类型：{pending['action_type']}")

    ids = pending["payload"].get("ids", [])
    affected = soft_delete(pending["record_type"], ids)
    resolve_pending(pending_id, "confirmed")
    return {"deleted": affected, "record_type": pending["record_type"], "ids": ids}


# ---------------------------------------------------------------- 对话历史


def add_chat_message(role: str, content: str) -> None:
    """追加一条对话记录。"""
    db.execute(
        "INSERT INTO chat_messages (role, content, created_at) VALUES (?, ?, ?)",
        (role, content, utils.now_str()),
    )


def list_chat_messages(limit: int = 50) -> list[dict]:
    """按时间正序取最近若干条对话。"""
    rows = db.query(
        f"SELECT * FROM chat_messages ORDER BY id DESC LIMIT {int(limit)}"
    )
    return list(reversed(rows))


def clear_chat_messages() -> int:
    """清空对话历史。"""
    return db.execute("DELETE FROM chat_messages")


def prune_chat_messages(keep_days: int) -> int:
    """清理超过保留期的对话历史。"""
    if keep_days <= 0:
        return 0
    from datetime import date, timedelta

    cutoff = (date.today() - timedelta(days=keep_days)).isoformat()
    return db.execute("DELETE FROM chat_messages WHERE created_at < ?", (cutoff,))


# ---------------------------------------------------------------- 导出导入


def export_all() -> dict:
    """导出全部数据，供备份或自行分析。"""
    return {
        "exported_at": utils.now_str(),
        "profile": get_profile(),
        "goals": get_goals(),
        "diet": list_records("diet"),
        "workout": list_records("workout"),
        "body": list_records("body"),
    }


def import_all(data: dict, replace: bool = False) -> dict:
    """回导数据。replace 为真时先清空同类记录。"""
    result: dict[str, int] = {}

    if replace:
        for record_type in RECORD_TYPES:
            db.execute(f"DELETE FROM {RECORD_TYPES[record_type]['table']}")

    for record_type in RECORD_TYPES:
        rows = data.get(record_type) or []
        count = 0
        for row in rows:
            payload = {
                key: value
                for key, value in row.items()
                if key in RECORD_TYPES[record_type]["fields"]
            }
            try:
                add_record(record_type, payload)
                count += 1
            except RepositoryError:
                continue
        result[record_type] = count

    if isinstance(data.get("profile"), dict):
        update_profile(data["profile"])
    if isinstance(data.get("goals"), dict):
        update_goals(data["goals"])

    return result
