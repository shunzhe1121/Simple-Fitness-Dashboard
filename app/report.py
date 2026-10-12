"""AI 日报生成。

聚合某天的全部记录 + 近 7 天趋势 + 长期记忆，交给 LLM 产出一份
Markdown 日报，归档到 data/reports/YYYY-MM-DD.md 并入库（/reports 页面读库）。

LLM 未配置或调用失败时回退本地模板：日报功能不依赖模型可用性，
数据先落库，模型充值/恢复后可对同一天重新生成。
"""

from __future__ import annotations

import json
import re
from datetime import date, timedelta

from . import config, memory, repository, utils

REPORT_PROMPT = """你是一名懂运动科学与营养学的私人教练。请基于下面的结构化数据，\
用 Markdown 写一份简洁的中文日报，严格按以下小节组织：

## 总览
（2~3 句话概括当天：吃练睡的整体评价）

## 饮食
（热量/蛋白达标情况，对照目标，指出缺口或过量）

## 训练
（训练内容评价与负荷分析；休息日就说明恢复安排是否合理）

## 身体与恢复
（睡眠质量、静息心率、压力、步数；佳明数据缺失就明确说"今日无手表数据"）

## 明日建议
（1~3 条可执行建议，具体到数值，不写空话）

注意：只依据数据说话，缺失的数据不要编造。不要复述原始 JSON。

{memory_block}

## 当日数据
{daily_json}

## 近7天趋势
{trend_json}
"""


def _llm() -> "object | None":
    """返回可用的 LLM 实例，未配置返回 None。"""
    if not config.llm_configured():
        return None
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        api_key=config.LLM_API_KEY,
        base_url=config.LLM_BASE_URL,
        model=config.LLM_MODEL,
        temperature=config.LLM_TEMPERATURE,
    )


def _clean(obj) -> dict:
    """去掉 None 值，压缩 JSON 体积。"""
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if v not in (None, "", [], {})}
    if isinstance(obj, list):
        return [_clean(v) for v in obj if v not in (None, "", [], {})]
    return obj


def _last_days(n: int, until: str) -> list[str]:
    end = date.fromisoformat(until)
    return [(end - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]


def _fallback_report(target: str) -> str:
    """LLM 不可用时的本地模板日报。"""
    daily = repository.daily_summary(target)
    diet = daily.get("diet") or {}
    workout = daily.get("workout") or {}
    diet_total = diet.get("total") or {}
    workout_total = workout.get("total") or {}
    body = daily.get("body") or {}

    band = daily.get("deficit_band")
    band_label = band.get("label") if isinstance(band, dict) else band
    # 消耗口径分三个层次，日报里要讲清楚：公式 TDEE / 最近一次完整实测 / 当天实时值
    measured = daily.get("tdee_measured")
    measured_at = daily.get("tdee_measured_date")
    today_burn = daily.get("today_burn")
    burn_parts = [f"公式 TDEE {daily.get('tdee') or '未测算'} kcal"]
    if measured:
        suffix = "（今天）" if daily.get("is_measured_today") else f"（{measured_at}，最近一次完整数据）"
        burn_parts.append(f"手表实测总消耗 {measured:g} kcal{suffix}")
    if today_burn and daily.get("today_burn_estimated"):
        burn_parts.append(f"当天实时估算 {today_burn:g} kcal（按步数折算，随步数上升）")
    lines = [
        f"# 日报 {target}",
        "",
        "> 本报告由本地模板生成（AI 未配置或调用失败），数据完整，可在 AI 可用后重新生成。",
        "",
        "## 总览",
        "",
        "- 总消耗基准：" + "；".join(burn_parts),
        f"- 热量缺口：{daily.get('deficit') if daily.get('deficit') is not None else '—'}"
        + (f"（{band_label}）" if band_label else ""),
        f"- 可吃目标 {daily.get('target_calories') or '—'} kcal"
        + ("（已按手表实测消耗动态调整）" if measured else "（基础目标，无手表数据）"),
        f"- 饮食 {diet_total.get('count', 0)} 条，共 {diet_total.get('calories', 0):g} kcal，"
        f"蛋白质 {diet_total.get('protein', 0):g} g。",
        f"- 训练 {workout_total.get('count', 0)} 条，共 {workout_total.get('duration_min', 0):g} 分钟，"
        f"消耗 {workout_total.get('calories', 0):g} kcal。",
        "",
        "## 饮食",
        "",
    ]
    for item in diet.get("records", []):
        head = f"- {item.get('meal_type') or '餐'}：{item.get('food_name')}"
        extras = []
        if item.get("calories") is not None:
            extras.append(f"{item['calories']:g} kcal")
        if item.get("protein") is not None:
            extras.append(f"蛋白 {item['protein']:g} g")
        lines.append(head + ("（" + "，".join(extras) + "）" if extras else ""))
    lines += ["", "## 训练", ""]
    if not workout.get("records"):
        lines.append("- 休息日")
    for item in workout.get("records", []):
        parts = [item.get("category")]
        if item.get("duration_min") is not None:
            parts.append(f"{item['duration_min']:g} 分钟")
        if item.get("distance_km") is not None:
            parts.append(f"{item['distance_km']:g} km")
        if item.get("calories") is not None:
            parts.append(f"{item['calories']:g} kcal")
        lines.append("- " + "，".join(str(p) for p in parts))
    lines += ["", "## 身体与恢复", ""]
    if not body:
        lines.append("- 无记录")
    else:
        parts = [
            f"睡眠 {body['sleep_hours']}h" if body.get("sleep_hours") else None,
            f"睡眠评分 {int(body['sleep_score'])}" if body.get("sleep_score") else None,
            f"静息心率 {body['resting_hr']:g}" if body.get("resting_hr") else None,
            f"压力 {body['stress_avg']:g}" if body.get("stress_avg") else None,
            f"步数 {int(body['steps'])}" if body.get("steps") else None,
            f"总消耗 {body['calories_burned']:g} kcal" if body.get("calories_burned") else None,
        ]
        lines += ["- " + p for p in parts if p] or ["- 无手表数据"]
    return "\n".join(lines) + "\n"


def generate(target: str | None = None, force: bool = False) -> dict:
    """生成（或重新生成）某天日报，返回 {date, model, fallback}。"""
    target = utils.resolve_date(target) if target else utils.today_str()

    existing = repository.get_daily_report(target)
    if existing and not force:
        return {"date": target, "model": existing["model"], "cached": True}

    daily = _clean(repository.daily_summary(target))
    trend_from = (date.fromisoformat(target) - timedelta(days=6)).isoformat()
    trend = _clean(repository.range_stats(trend_from, target))

    model_name = config.LLM_MODEL if config.llm_configured() else None
    content = None
    if model_name:
        memory_block = memory.load_memory() or "（暂无长期记忆）"
        prompt = REPORT_PROMPT.format(
            memory_block=f"### 关于用户的长期记忆\n{memory_block}",
            daily_json=json.dumps(daily, ensure_ascii=False),
            trend_json=json.dumps(trend, ensure_ascii=False),
        )
        try:
            resp = _llm().invoke(prompt)
            content = (resp.content or "").strip()
        except Exception:
            content = None

    fallback = content is None
    if fallback:
        content = _fallback_report(target)
        model_name = None

    _archive_md(target, content)
    repository.save_daily_report(target, content, model_name)
    return {"date": target, "model": model_name, "fallback": fallback, "cached": False}


def _archive_md(target: str, content: str) -> None:
    """把日报写到 data/reports/YYYY-MM-DD.md。"""
    config.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (config.REPORTS_DIR / f"{target}.md").write_text(content, encoding="utf-8")


# ------------------------------------------------ 极简 MD → HTML

_MD_RULES = [
    (re.compile(r"^### (.*)$", re.M), r"<h3>\1</h3>"),
    (re.compile(r"^## (.*)$", re.M), r"<h2>\1</h2>"),
    (re.compile(r"^# (.*)$", re.M), r"<h1>\1</h1>"),
    (re.compile(r"^> (.*)$", re.M), r"<blockquote>\1</blockquote>"),
    (re.compile(r"\*\*(.+?)\*\*"), r"<strong>\1</strong>"),
    (re.compile(r"^- (.*)$", re.M), r"<li>\1</li>"),
]


def md_to_html(md: str) -> str:
    """够用的极简转换：标题/加粗/列表/段落，不引第三方依赖。"""
    html = md
    for pattern, repl in _MD_RULES:
        html = pattern.sub(repl, html)
    # 相邻 <li> 合并成 <ul>
    html = re.sub(r"(<li>.*?</li>\n?)+", lambda m: "<ul>" + m.group(0) + "</ul>", html)
    parts = [p for p in html.split("\n\n") if p.strip()]
    block_tags = ("<h", "<ul>", "<blockquote>")
    return "\n".join(
        f"<p>{p.strip()}</p>" if not p.lstrip().startswith(block_tags) else p.strip()
        for p in parts
    )
