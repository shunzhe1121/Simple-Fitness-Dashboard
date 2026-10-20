"""FastAPI 路由层。

按 API-first 设计：网页只是这套接口的一个客户端，
将来做原生 App 或套壳客户端可以直接复用同一批 /api 端点。
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, freetext, nutrition, parser, repository, utils
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


# 未授权时的入口页：给一个输入框，填一次令牌即可，手机上也用得顺手
_UNAUTHORIZED_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>需要访问令牌</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f5f5f4; color: #1c1c1b;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .box { width: 100%; max-width: 340px; padding: 28px 24px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 10px; }
  p { font-size: 13px; line-height: 1.7; color: #6b6a66; margin: 0 0 20px; }
  input {
    width: 100%; box-sizing: border-box; padding: 12px 14px; font-size: 15px;
    border: 1px solid #d6d3cd; border-radius: 10px; background: #fff; color: inherit;
    margin-bottom: 12px;
  }
  button {
    width: 100%; padding: 13px; font-size: 15px; font-weight: 500; color: #fff;
    background: #1c1c1b; border: 0; border-radius: 10px; cursor: pointer;
  }
  button:active { opacity: .85; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a19; color: #f0efec; }
    p { color: #9d9b96; }
    input { background: #262624; border-color: #3a3a37; }
    button { background: #f0efec; color: #1a1a19; }
  }
</style>
</head>
<body>
  <div class="box">
    <h1>需要访问令牌</h1>
    <p>这个服务只对本人开放。输入访问令牌后即可进入，令牌保存在电脑的 .env 文件里（ACCESS_TOKEN 那一行）。</p>
    <form method="get" action="/">
      <input name="k" type="password" placeholder="访问令牌" autocomplete="off" autofocus>
      <button type="submit">进入</button>
    </form>
  </div>
</body>
</html>"""


@app.middleware("http")
async def access_guard(request: Request, call_next):
    """访问校验。

    没有域名时走 Cloudflare 临时域名，服务等于直接挂在公网上，
    令牌是唯一凭据：带 ?k=令牌 首次进入后种下 cookie，之后凭 cookie 放行。
    重定向用相对路径，避免 Cloudflare 终结 TLS 后 scheme 判断出错。
    """
    if not config.access_enabled():
        return await call_next(request)

    token = config.ACCESS_TOKEN
    if request.cookies.get(config.COOKIE_NAME) == token:
        return await call_next(request)

    if request.query_params.get("k") == token:
        # 不设 secure：局域网用 http 访问时也要能用；传输段另有 Cloudflare 的 TLS
        response = RedirectResponse(url=request.url.path, status_code=303)
        response.set_cookie(
            config.COOKIE_NAME,
            token,
            max_age=config.COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
        )
        return response

    return HTMLResponse(_UNAUTHORIZED_PAGE, status_code=401)


@app.on_event("startup")
def on_startup() -> None:
    """启动时建表，清理超期对话历史，并确保访问令牌存在。"""
    config.ensure_access_token()
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
        "vision": config.vision_status(),
        "access": {
            "enabled": config.access_enabled(),
            "token": config.ACCESS_TOKEN,
        },
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
    """只解析不入库，供前端展示解析结果。

    走分层解析：模板文本由本地规则零成本吃掉，只有解析不出的残余片段
    才调 LLM。返回里带 tier 字段区分走了哪一层。
    """
    return freetext.parse_tiered(payload.text, default_date=payload.date)


@app.post("/api/parse/import")
def parse_import(payload: ParsePayload) -> dict:
    """解析粘贴文本并直接入库。

    与 preview 同一套分层解析：符合模板的部分不消耗 LLM 额度，
    不符合的残余片段才交给模型结构化。
    """
    parsed = freetext.parse_tiered(payload.text, default_date=payload.date)

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
        detail = "没能解析出任何记录。" + "；".join(parsed["warnings"])
        if parsed.get("llm_error"):
            detail += f"（{parsed['llm_error']}）"
        raise HTTPException(400, detail)

    return {
        "saved": saved,
        "count": total,
        "warnings": parsed["warnings"],
        "unparsed": parsed["unparsed"],
        "tier": parsed.get("tier", "local"),
    }


# ---------------------------------------------------------------- 拍照识餐
# 平时拍照攒着，等电脑开着时一次性上传识别。识别出来的文本与「粘贴识图结果」
# 走同一个 parser，所以前端拿到的 parsed 结构与 /api/parse/preview 完全一致。


class MealAnalyzePayload(BaseModel):
    ids: Optional[list[int]] = None
    date: Optional[str] = None


@app.post("/api/meals/upload")
async def meals_upload(
    files: list[UploadFile] = File(...),
    date: Optional[str] = Form(None),
) -> dict:
    """上传一张或多张餐食照片。原图压缩后落盘，单张失败不影响其余。"""
    from . import vision

    day = utils.resolve_date(date) or utils.today_str()
    limit_bytes = config.MAX_IMAGE_MB * 1024 * 1024
    saved: list[dict] = []
    failed: list[dict] = []

    for item in files:
        name = item.filename or "photo.jpg"
        try:
            raw = await item.read()
            if not raw:
                failed.append({"name": name, "error": "空文件"})
                continue
            if len(raw) > limit_bytes:
                failed.append(
                    {"name": name, "error": f"超过 {config.MAX_IMAGE_MB:g} MB 上限"}
                )
                continue
            stored = vision.save_image(raw, name, day)
            row = repository.add_meal_image(
                day, stored["stored_name"], name, stored["mime"]
            )
            row["bytes"] = stored["bytes"]
            saved.append(row)
        except vision.VisionError as error:
            failed.append({"name": name, "error": str(error)})
        except Exception as error:  # noqa: BLE001 — 单张失败不能拖垮整批
            failed.append({"name": name, "error": f"保存失败：{error}"})

    return {"date": day, "saved": saved, "failed": failed}


@app.get("/api/meals")
def list_meals(date: Optional[str] = None, limit: int = 200) -> dict:
    """图库列表，附带识图能力的配置状态。"""
    rows = repository.list_meal_images(day=date, limit=limit)
    return {
        "images": rows,
        "count": len(rows),
        "vision": config.vision_status(),
    }


@app.get("/api/meals/{meal_id}/image")
def meal_image(meal_id: int) -> Response:
    from . import vision

    row = repository.get_meal_image(meal_id)
    if not row:
        raise HTTPException(404, "图片不存在")
    path = vision.image_path(row["stored_name"])
    if not path.exists():
        raise HTTPException(404, "图片文件已丢失")
    return FileResponse(path, media_type=row.get("mime") or "image/jpeg")


@app.post("/api/meals/analyze")
def meals_analyze(payload: MealAnalyzePayload) -> dict:
    """识别图片并解析，只返回结果不入库——入不入库交给用户确认。

    不传 ids 时取所有待识别/上次失败的图片，按拍摄顺序处理。
    """
    from . import vision

    if payload.ids:
        rows = [row for row in (repository.get_meal_image(i) for i in payload.ids) if row]
    else:
        rows = repository.list_unanalyzed_meal_images(payload.date)

    if not rows:
        return {"analyzed": [], "parsed": None, "warnings": ["没有待识别的图片"]}

    outcomes: list[dict] = []
    texts: list[str] = []

    for row in rows:
        result = vision.analyze(vision.image_path(row["stored_name"]))
        if result["error"]:
            repository.update_meal_image(
                row["id"], status="failed", error=result["error"]
            )
            outcomes.append(
                {"id": row["id"], "original": row.get("original"), "ok": False,
                 "error": result["error"]}
            )
            continue
        repository.update_meal_image(
            row["id"], status="analyzed", result_text=result["text"], error=None
        )
        texts.append(result["text"])
        outcomes.append(
            {"id": row["id"], "original": row.get("original"), "ok": True,
             "text": result["text"]}
        )

    if not texts:
        return {
            "analyzed": outcomes,
            "parsed": None,
            "warnings": ["这些图片都没能识别出内容，看下面的错误信息"],
        }

    parsed = parser.parse(vision.merge_texts(texts), default_date=payload.date)
    return {"analyzed": outcomes, "parsed": parsed, "vision": config.vision_status()}


class MealMarkPayload(BaseModel):
    ids: list[int]


@app.post("/api/meals/mark-imported")
def meals_mark_imported(payload: MealMarkPayload) -> dict:
    """把图片标成已入库。

    前端确认入库后调用，避免同一批图片下次又被识别一遍。
    """
    updated = 0
    for meal_id in payload.ids:
        if repository.update_meal_image(meal_id, status="imported"):
            updated += 1
    return {"updated": updated}


@app.delete("/api/meals/{meal_id}")
def delete_meal(meal_id: int) -> dict:
    count = repository.delete_meal_image(meal_id)
    if not count:
        raise HTTPException(404, "图片不存在")
    return {"deleted": count}


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
