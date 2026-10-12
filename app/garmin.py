"""佳明（Garmin）数据同步。

用 garth 库模拟登录 Garmin Connect，把每日睡眠、热量消耗、心率、
压力、步数、体重与活动记录（跑步等）拉回来，经字段级合并写入本地库。

登录凭据从环境变量 GARMIN_EMAIL / GARMIN_PASSWORD 读取（.env），
OAuth token 缓存在 data/garmin_tokens/，登录成功后日常同步不需要
重复输密码。手机号也能当账号用。
"""

from __future__ import annotations

import json
import socket
from datetime import date, timedelta
from pathlib import Path

from . import config, repository, utils

# garth 用 requests 且默认不设超时，个别请求会无限挂起；
# 全局兜底 30 秒，超时抛异常走逐日容错。
socket.setdefaulttimeout(30)

TOKEN_DIR = config.DB_PATH.parent / "garmin_tokens"

# connectapi 各端点返回的字段名因账号/固件略有差异，取值一律走
# 链式 .get 容错，缺什么就留空，绝不让一次同步整批失败。


def _client():
    import garth  # 延迟导入，未安装时给出清晰提示

    return garth.client


def _resume_or_login(email: str, password: str, domain: str = "garmin.cn") -> None:
    """优先用本地 token 恢复会话，失败再账密登录并缓存 token。

    国内佳明账号必须用 garmin.cn 域，默认全球站会 429 拒掉。
    garth 0.8.0 是 Client API：load/dump/login 都挂在 client 上。
    """
    client = _client()
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    try:
        client.load(str(TOKEN_DIR))  # load 内部会按 oauth1 token 恢复域名
        return
    except Exception:
        pass
    client.domain = domain
    result = client.login(email, password, return_on_mfa=True)
    if result[0] == "needs_mfa":
        raise RuntimeError(
            "佳明要求 MFA 验证码：请运行 scripts/garmin_login.py 完成一次短信验证，"
            "之后 token 缓存可长期使用"
        )
    client.dump(str(TOKEN_DIR))


def _days(n: int, until: str | None = None) -> list[str]:
    """返回最近 n 天的日期串（含 until，默认到今天）。

    早于 config.GARMIN_SINCE 的日期直接剔除：清空历史后重新开始用的场景下，
    7 天回看窗口会把刚删掉的旧日期又填回来，这里拦一刀。
    """
    end = utils.resolve_date(until) if until else utils.today_str()
    end_date = date.fromisoformat(end)
    days = [
        (end_date - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)
    ]
    since = config.GARMIN_SINCE
    if since:
        days = [d for d in days if d >= since]
    return days


def _num(value) -> float | None:
    """容错转数值，None/非法值返回 None。"""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _username(client) -> str:
    """取佳明用户名（sleep 端点路径需要），带内存缓存。"""
    global _USERNAME_CACHE
    if not _USERNAME_CACHE:
        profile = client.connectapi("/userprofile-service/socialProfile") or {}
        _USERNAME_CACHE = profile.get("userName") or profile.get("displayName") or ""
    return _USERNAME_CACHE


_USERNAME_CACHE = ""


def _sleep_body(day: str) -> dict | None:
    """睡眠数据 → body 记录字段。"""
    client = _client()
    try:
        user = _username(client)
        raw = client.connectapi(
            f"/wellness-service/wellness/dailySleepData/{user}"
            f"?nonSleepBufferMinutes=60&date={day}"
        )
    except Exception:
        return None
    dto = (raw or {}).get("dailySleepDTO") or {}
    duration_ms = _num(dto.get("sleepTimeSeconds"))
    if duration_ms is None:
        return None
    body = {
        "date": day,
        "sleep_hours": round(duration_ms / 3600, 2),
        "deep_sleep_min": (
            round(_num(dto.get("deepSleepSeconds")) / 60)
            if dto.get("deepSleepSeconds")
            else None
        ),
        "rem_sleep_min": (
            round(_num(dto.get("remSleepSeconds")) / 60)
            if dto.get("remSleepSeconds")
            else None
        ),
        "sleep_score": _num(
            (dto.get("sleepScores") or {}).get("overall", {}).get("value")
        ),
    }
    return body


def _summary_body(day: str) -> dict | None:
    """每日汇总（消耗/步数/静息心率/压力）→ body 记录字段。"""
    client = _client()
    try:
        raw = client.connectapi(
            f"/usersummary-service/usersummary/daily/?calendarDate={day}"
        )
    except Exception:
        return None
    if not raw:
        return None
    body = {
        "date": day,
        "steps": _num(raw.get("totalSteps")),
        # 总消耗（含基础代谢）与饮食摄入直接对比
        "calories_burned": _num(raw.get("totalKilocalories")),
        "resting_hr": _num(raw.get("restingHeartRate")),
        "stress_avg": _num(raw.get("averageStressLevel")),
    }
    if all(v is None for k, v in body.items() if k != "date"):
        return None
    return body


# 称重是稀疏事件（一个月可能只称几次），所以体重不走逐日循环，
# 单独用一个更宽的回看窗口，电脑关机几天再开机也不会漏掉期间的称重。
WEIGHT_LOOKBACK_DAYS = 30


def _kg(grams) -> float | None:
    """佳明体重端点一律返回克（与账号的米制/英制设置无关），转成 kg。"""
    value = _num(grams)
    if value is None or value <= 0:
        return None
    return round(value / 1000, 2)


def _weights(start: str, end: str) -> dict[str, dict]:
    """区间体重查询 → {日期: {weight, body_fat}}。

    用 dateRange 端点一次拿整段区间，比逐日调 dayview 少打很多请求。
    同一天可能有多次称重，按时间排序后逐个覆盖，自然留下最后一条。
    没有佳明智能秤时只有 sourceType=MANUAL/USER_SETTING 的体重，
    bodyFat/bmi/muscleMass 全是 null，这里只取有值的字段。
    """
    client = _client()
    try:
        raw = client.connectapi(
            "/weight-service/weight/dateRange",
            params={"startDate": start, "endDate": end},
        )
    except Exception:
        return {}
    rows = (raw or {}).get("dateWeightList") or []
    out: dict[str, dict] = {}
    for row in sorted(rows, key=lambda r: r.get("date") or 0):
        day = row.get("calendarDate")
        if not day:
            continue
        fields = {
            "weight": _kg(row.get("weight")),
            "body_fat": _num(row.get("bodyFat")),
        }
        if all(v is None for v in fields.values()):
            continue
        out[day] = fields
    return out


def _activities(day: str) -> list[dict]:
    """当天活动（跑步/骑行等）→ cardio 类 workout 记录。"""
    client = _client()
    try:
        acts = client.connectapi(
            "/activitylist-service/activities/search/activities",
            params={
                "startDate": day,
                "endDate": day,
                "limit": 50,
            },
        ) or []
    except Exception:
        return []
    out = []
    # 佳明活动类型 → 本项目的训练类目（前端 CATEGORIES：有氧/胸/背/腿/肩/手臂/核心/全身）
    AEROBIC = {
        "running", "trail_running", "treadmill_running", "cycling", "road_biking",
        "indoor_cycling", "walking", "swimming", "pool_swim", "rowing", "elliptical",
        "hiking", "virtual_ride", "fitness_equipment",
    }
    for act in acts:
        start = (act.get("startTimeLocal") or "")[:10]
        if start != day:
            continue
        type_key = (act.get("activityType") or {}).get("typeKey") or ""
        category = "有氧" if type_key in AEROBIC else "全身"
        out.append(
            {
                "date": day,
                "category": category,
                "duration_min": round(_num(act.get("duration")) / 60)
                if act.get("duration")
                else None,
                "calories": _num(act.get("calories")),
                "distance_km": _num(act.get("distance")),
                "avg_hr": _num(act.get("averageHR")),
                "note": f"{type_key} {act.get('activityName') or ''}".strip() or None,
            }
        )
    return out


def sync(days: int = 7, until: str | None = None, email: str = "", password: str = "") -> dict:
    """同步最近 n 天的佳明数据，返回逐日结果摘要。

    单天失败只记 warning 不中断：同步应该是每天都能重跑的幂等操作。
    """
    email = email or config.GARMIN_EMAIL
    password = password or config.GARMIN_PASSWORD
    if not email or not password:
        raise RuntimeError("缺少佳明账号：请在 .env 配置 GARMIN_EMAIL / GARMIN_PASSWORD")

    _resume_or_login(email, password)
    print("[garmin] 登录成功", flush=True)

    days = _days(days, until)
    result: dict = {
        "days": {},
        "token_dir": str(TOKEN_DIR),
        "weights": {},
        "errors": [],
    }
    for day in days:
        day_info: dict = {"body": False, "activities": 0, "errors": []}

        merged_body: dict = {"date": day}
        for fetcher in (_sleep_body, _summary_body):
            try:
                piece = fetcher(day)
            except Exception as exc:  # 单接口挂了不拖垮整周
                day_info["errors"].append(str(exc)[:120])
                piece = None
            if piece:
                merged_body.update(piece)
        try:
            has_data = any(v is not None for k, v in merged_body.items() if k != "date")
            if has_data:
                repository.upsert_device_record("body", merged_body, {"date": day})
                day_info["body"] = True
        except Exception as exc:
            day_info["errors"].append(str(exc)[:120])

        try:
            for act in _activities(day):
                repository.upsert_device_record(
                    "workout",
                    act,
                    {"date": day, "category": act["category"]},
                )
                day_info["activities"] += 1
        except Exception as exc:
            day_info["errors"].append(str(exc)[:120])

        kinds = ",".join(
            k for k, v in (("body", day_info["body"]), ("activities", day_info["activities"]))
            if v
        )
        if kinds:
            repository.mark_garmin_synced(day, kinds)
        result["days"][day] = day_info

    _sync_weights(result, until)
    return result


def _sync_weights(result: dict, until: str | None) -> None:
    """体重单独一趟，窗口比逐日数据宽（见 WEIGHT_LOOKBACK_DAYS）。

    写入走 upsert_device_record：日期上已经有用户手填的体重时只补空缺，
    不会被设备值覆盖，所以这里可以放心地反复重跑这 30 天。
    """
    end = utils.resolve_date(until) if until else utils.today_str()
    start = (date.fromisoformat(end) - timedelta(days=WEIGHT_LOOKBACK_DAYS - 1)).isoformat()
    if config.GARMIN_SINCE:
        start = max(start, config.GARMIN_SINCE)
    if start > end:
        return  # 起算日之后还没到任何一天，无事可做

    for day, fields in _weights(start, end).items():
        try:
            repository.upsert_device_record("body", {"date": day, **fields}, {"date": day})
            result["weights"][day] = fields
        except Exception as exc:
            result["errors"].append(f"{day} 体重写入失败：{str(exc)[:100]}")
