"""FastAPI 路由层。

按 API-first 设计：网页只是这套接口的一个客户端，
将来做原生 App 或套壳客户端可以直接复用同一批 /api 端点。
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, nutrition, parser, repository, utils
from .agent import graph as agent_graph

app = FastAPI(title="健身记录助手", version="1.0.0")

# 允许跨域，方便将来 App 或独立前端直连
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    """启动时建表，并清理超期的对话历史。"""
    db.init_db()
    repository.prune_chat_messages(config.CHAT_HISTORY_DAYS)


# ---------------------------------------------------------------- 请求模型


class ProfilePayload(BaseModel):
    height: Optional[float] = None
    birth_year: Optional[int] = None
    gender: Optional[str] = None
    activity_level: Optional[str] = None
    goal_type: Optional[str] = None


class GoalsPayload(BaseModel):
    bmr: Optional[float] = None
    tdee: Optional[float] = None
    daily_calories: Optional[float] = None
    protein_g: Optional[float] = None
    fat_g: Optional[float] = None
    carbs_g: Optional[float] = None
    target_weight: Optional[float] = None
    workout_days_per_week: Optional[int] = None


class GoalsCalcPayload(BaseModel):
    weight: Optional[float] = None
    height: Optional[float] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    activity_level: Optional[str] = None
    goal_type: Optional[str] = None
    target_weight: Optional[float] = None
    workout_days_per_week: Optional[int] = None


class ParsePayload(BaseModel):
    text: str
    date: Optional[str] = None


class ChatPayload(BaseModel):
    message: str


class ImportPayload(BaseModel):
    data: dict
    replace: bool = False


# ---------------------------------------------------------------- 元信息


@app.get("/api/meta")
def get_meta() -> dict:
    """前端启动时拉取的元信息：配置状态、选项、模板提示词。"""
    return {
        "today": utils.today_str(),
        "llm": config.llm_status(),
        "options": nutrition.options(),
        "record_types": {
            key: value["label"] for key, value in repository.RECORD_TYPES.items()
        },
        "doubao_prompt": parser.DOUBAO_PROMPT,
        "chat_history_days": config.CHAT_HISTORY_DAYS,
    }


# ---------------------------------------------------------------- 资料与目标


@app.get("/api/profile")
def get_profile() -> dict:
    return repository.get_profile()


@app.put("/api/profile")
def put_profile(payload: ProfilePayload) -> dict:
    fields = payload.model_dump(exclude_none=True)
    if fields.get("activity_level"):
        fields["activity_level"] = nutrition.normalize_activity(fields["activity_level"])
    if fields.get("goal_type"):
        fields["goal_type"] = nutrition.normalize_goal(fields["goal_type"])
    return repository.update_profile(fields)


@app.get("/api/goals")
def get_goals() -> dict:
    return repository.get_goals()


@app.put("/api/goals")
def put_goals(payload: GoalsPayload) -> dict:
    return repository.update_goals(payload.model_dump(exclude_none=True))


@app.post("/api/goals/calc")
def calc_goals(payload: GoalsCalcPayload) -> dict:
    """按身体数据推算 TDEE 与宏量目标并保存。"""
    profile = repository.get_profile()

    weight = payload.weight or profile.get("latest_weight")
    height = payload.height or profile.get("height")
    age = payload.age or profile.get("age")
    gender = payload.gender or profile.get("gender")

    missing = [
        label
        for label, value in (
            ("体重", weight),
            ("身高", height),
            ("年龄", age),
            ("性别", gender),
        )
        if not value
    ]
    if missing:
        raise HTTPException(400, "缺少必要信息：" + "、".join(missing))

    plan = nutrition.calc_plan(
        weight=weight,
        height=height,
        age=age,
        gender=gender,
        activity_level=payload.activity_level or profile.get("activity_level"),
        goal_type=payload.goal_type or profile.get("goal_type"),
    )

    repository.update_profile(
        {
            "height": height,
            "gender": plan["gender"],
            "activity_level": plan["activity_level"],
            "goal_type": plan["goal_type"],
        }
    )
    goals = repository.update_goals(
        {
            "bmr": plan["bmr"],
            "tdee": plan["tdee"],
            "daily_calories": plan["daily_calories"],
            "protein_g": plan["protein_g"],
            "fat_g": plan["fat_g"],
            "carbs_g": plan["carbs_g"],
            "target_weight": payload.target_weight,
            "workout_days_per_week": payload.workout_days_per_week,
        }
    )

    return {"plan": plan, "goals": goals, "profile": repository.get_profile()}


# ---------------------------------------------------------------- 记录 CRUD


def _check_record_type(record_type: str) -> None:
    if record_type not in repository.RECORD_TYPES:
        allowed = "、".join(repository.RECORD_TYPES)
        raise HTTPException(404, f"未知记录类型 {record_type}，可选：{allowed}")


@app.get("/api/records/{record_type}")
def list_records(
    record_type: str,
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: Optional[int] = None,
) -> dict:
    _check_record_type(record_type)
    rows = repository.list_records(
        record_type, date=date, date_from=date_from, date_to=date_to, limit=limit
    )
    return {"records": rows, "count": len(rows)}


@app.post("/api/records/{record_type}")
def create_record(record_type: str, payload: dict) -> dict:
    """新增记录。payload 支持单条对象，也支持 {"records": [...]}。"""
    _check_record_type(record_type)
    items = payload.get("records") if isinstance(payload.get("records"), list) else [payload]
    try:
        saved = repository.add_records(record_type, items)
    except repository.RepositoryError as error:
        raise HTTPException(400, str(error)) from error
    return {"records": saved, "count": len(saved)}


@app.put("/api/records/{record_type}/{record_id}")
def edit_record(record_type: str, record_id: int, payload: dict) -> dict:
    _check_record_type(record_type)
    try:
        return repository.update_record(record_type, record_id, payload)
    except repository.RepositoryError as error:
        raise HTTPException(400, str(error)) from error


@app.delete("/api/records/{record_type}/{record_id}")
def delete_record(record_type: str, record_id: int) -> dict:
    """软删除单条记录，删错了可以从回收站恢复。"""
    _check_record_type(record_type)
    affected = repository.soft_delete(record_type, [record_id])
    if not affected:
        raise HTTPException(404, f"没找到 id={record_id} 的记录，或它已被删除")
    return {"deleted": affected}


@app.get("/api/records/{record_type}/trash")
def list_trash(record_type: str, limit: int = 50) -> dict:
    _check_record_type(record_type)
    rows = repository.list_deleted(record_type, limit)
    return {"records": rows, "count": len(rows)}


@app.post("/api/records/{record_type}/{record_id}/restore")
def restore_record(record_type: str, record_id: int) -> dict:
    _check_record_type(record_type)
    affected = repository.restore(record_type, [record_id])
    if not affected:
        raise HTTPException(404, f"没找到 id={record_id} 的记录")
    return {"restored": affected}


# ---------------------------------------------------------------- 模板解析


@app.post("/api/parse/preview")
def parse_preview(payload: ParsePayload) -> dict:
    """只解析不入库，供前端展示解析结果。"""
    return parser.parse(payload.text, default_date=payload.date)


@app.post("/api/parse/import")
def parse_import(payload: ParsePayload) -> dict:
    """解析粘贴文本并直接入库。走纯规则解析，不消耗 LLM 额度。"""
    parsed = parser.parse(payload.text, default_date=payload.date)

    saved: dict[str, list] = {}
    for record_type in ("diet", "workout", "body"):
        if not parsed[record_type]:
            continue
        try:
            saved[record_type] = repository.add_records(
                record_type, parsed[record_type]
            )
        except repository.RepositoryError as error:
            raise HTTPException(400, str(error)) from error

    total = sum(len(rows) for rows in saved.values())
    if not total:
        raise HTTPException(
            400,
            "没能解析出任何记录。" + "；".join(parsed["warnings"]),
        )

    return {
        "saved": saved,
        "count": total,
        "warnings": parsed["warnings"],
        "unparsed": parsed["unparsed"],
    }


# ---------------------------------------------------------------- 汇总统计


@app.get("/api/summary/daily")
def summary_daily(date: Optional[str] = None) -> dict:
    return repository.daily_summary(date)


@app.get("/api/stats/range")
def stats_range(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    days: Optional[int] = Query(default=None, ge=1, le=365),
) -> dict:
    """区间统计。给 days 走最近 N 天，否则用明确起止日期。"""
    if days:
        start, end = utils.date_range(days, date_to)
    else:
        start = date_from or utils.date_range(7)[0]
        end = date_to or utils.today_str()

    data = repository.range_stats(start, end)
    averages = data["averages"]
    data["macro_share"] = nutrition.macro_calories(
        averages["protein"], averages["fat"], averages["carbs"]
    )
    return data


# ---------------------------------------------------------------- Agent 对话


@app.post("/api/agent/chat")
def agent_chat(payload: ChatPayload) -> dict:
    """跑一轮 Agent 对话，返回回复、界面指令和待确认项。"""
    try:
        return agent_graph.chat(payload.message)
    except agent_graph.AgentUnavailable as error:
        # 用 200 返回，前端当成一条普通助手消息展示，体验比报错好
        return JSONResponse(
            {
                "reply": str(error),
                "ui_actions": [],
                "pending": [],
                "data_changed": False,
                "tools_called": [],
                "llm_unavailable": True,
            }
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except Exception as error:  # noqa: BLE001 - 兜住模型与网络异常
        raise HTTPException(500, f"Agent 执行失败：{error}") from error


@app.get("/api/agent/history")
def agent_history(limit: int = 50) -> dict:
    return {"messages": repository.list_chat_messages(limit)}


@app.delete("/api/agent/history")
def clear_agent_history() -> dict:
    return {"cleared": repository.clear_chat_messages()}


# ---------------------------------------------------------------- 待确认队列


@app.get("/api/pending")
def list_pending() -> dict:
    return {"pending": repository.list_pending()}


@app.post("/api/pending/{pending_id}/confirm")
def confirm_pending(pending_id: int) -> dict:
    """确认执行待办操作（目前只有删除）。"""
    try:
        return repository.confirm_pending(pending_id)
    except repository.RepositoryError as error:
        raise HTTPException(400, str(error)) from error


@app.post("/api/pending/{pending_id}/cancel")
def cancel_pending(pending_id: int) -> dict:
    repository.resolve_pending(pending_id, "cancelled")
    return {"cancelled": pending_id}


# ---------------------------------------------------------------- 导出导入


@app.get("/api/export")
def export_data(
    format: str = Query(default="json", pattern="^(json|csv)$"),
    record_type: Optional[str] = None,
) -> Response:
    """导出数据。json 导出全部，csv 需指定 record_type。"""
    if format == "json":
        content = json.dumps(repository.export_all(), ensure_ascii=False, indent=2)
        return Response(
            content=content.encode("utf-8"),
            media_type="application/json; charset=utf-8",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="fitness-{utils.today_str()}.json"'
                )
            },
        )

    if not record_type:
        raise HTTPException(400, "导出 CSV 需要指定 record_type")
    _check_record_type(record_type)

    rows = repository.list_records(record_type)
    columns = ["id", *repository.RECORD_TYPES[record_type]["fields"], "created_at"]

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)

    # 加 BOM，Excel 直接打开不乱码
    content = "\ufeff" + buffer.getvalue()
    return Response(
        content=content.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{record_type}-{utils.today_str()}.csv"'
            )
        },
    )


@app.post("/api/import")
def import_data(payload: ImportPayload) -> dict:
    """回导 JSON 备份。replace 为真时先清空原有记录。"""
    result = repository.import_all(payload.data, replace=payload.replace)
    return {"imported": result}


# ---------------------------------------------------------------- 佳明同步 / 日报 / 记忆


class GarminSyncPayload(BaseModel):
    days: int = 7
    until: Optional[str] = None


class ReportPayload(BaseModel):
    date: Optional[str] = None
    force: bool = False


class MemoryPayload(BaseModel):
    profile: str


@app.get("/api/garmin/status")
def garmin_status() -> dict:
    return {
        "configured": bool(config.GARMIN_EMAIL and config.GARMIN_PASSWORD),
        "last_sync": repository.last_garmin_sync(),
    }


@app.post("/api/garmin/sync")
def garmin_sync(payload: GarminSyncPayload) -> dict:
    """从 Garmin Connect 同步最近 n 天数据（睡眠/消耗/心率/步数/活动）。"""
    if not (config.GARMIN_EMAIL and config.GARMIN_PASSWORD):
        raise HTTPException(400, "请在 .env 配置 GARMIN_EMAIL / GARMIN_PASSWORD")
    from . import garmin

    try:
        return garmin.sync(
            days=max(1, min(payload.days, 30)),
            until=payload.until,
        )
    except RuntimeError as error:
        raise HTTPException(400, str(error)) from error
    except Exception as error:  # 网络失败、token 过期等
        raise HTTPException(502, f"佳明同步失败：{error}") from error


@app.get("/api/reports")
def reports_list(limit: int = 30) -> dict:
    return {"reports": repository.list_daily_reports(limit)}


@app.get("/api/reports/{report_date}")
def reports_get(report_date: str, html: bool = False) -> dict:
    report = repository.get_daily_report(report_date)
    if not report:
        raise HTTPException(404, "该日期还没有日报，可先调用生成接口")
    if html:
        from . import report as report_mod

        report = {**report, "html": report_mod.md_to_html(report["content"])}
    return {"report": report}


@app.post("/api/reports/generate")
def reports_generate(payload: ReportPayload) -> dict:
    """生成某天日报（已有且未 force 时直接返回缓存）。"""
    from . import report as report_mod

    try:
        return report_mod.generate(payload.date, force=payload.force)
    except Exception as error:
        raise HTTPException(500, f"日报生成失败：{error}") from error


@app.get("/api/memory")
def memory_get() -> dict:
    from . import memory as memory_mod

    return {
        "profile": memory_mod.read_profile(),
        "summary": memory_mod.read_summary(),
    }


@app.put("/api/memory")
def memory_put(payload: MemoryPayload) -> dict:
    from . import memory as memory_mod

    memory_mod.write_profile(payload.profile)
    return {"saved": True}


# ---------------------------------------------------------------- 静态资源

# 静态挂载必须放在所有 /api 路由之后，否则会抢占请求
app.mount(
    "/",
    StaticFiles(directory=str(config.STATIC_DIR), html=True),
    name="static",
)
