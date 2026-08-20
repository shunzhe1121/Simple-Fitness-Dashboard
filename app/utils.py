"""日期与数值的通用处理。

Agent 拿到的日期可能是「今天」「昨天」「3-15」这类口语或简写，
统一在这里归一化成 YYYY-MM-DD，避免各处重复实现。
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

# 口语日期到偏移天数的映射
_RELATIVE_DAYS = {
    "今天": 0,
    "今日": 0,
    "本日": 0,
    "today": 0,
    "昨天": -1,
    "昨日": -1,
    "yesterday": -1,
    "前天": -2,
    "明天": 1,
    "tomorrow": 1,
}

# 纯数字日期的常见写法
_FULL_DATE = re.compile(r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$")
_SHORT_DATE = re.compile(r"^(\d{1,2})[-/.月](\d{1,2})日?$")
_COMPACT_DATE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")


def today_str() -> str:
    """返回本地当天日期字符串。"""
    return date.today().isoformat()


def now_str() -> str:
    """返回本地当前时刻字符串，用于 created_at。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def resolve_date(value: str | None, default_today: bool = True) -> str | None:
    """把各种日期写法归一化为 YYYY-MM-DD。

    参数:
        value: 待解析的日期文本，可为 None
        default_today: 无法解析或为空时是否回退到今天

    返回:
        归一化后的日期字符串；default_today 为 False 且解析失败时返回 None
    """
    fallback = today_str() if default_today else None

    if value is None:
        return fallback

    text = str(value).strip()
    if not text:
        return fallback

    # 口语相对日期
    if text in _RELATIVE_DAYS:
        return (date.today() + timedelta(days=_RELATIVE_DAYS[text])).isoformat()

    # 「N 天前」这类写法
    days_ago = re.match(r"^(\d+)\s*天前$", text)
    if days_ago:
        return (date.today() - timedelta(days=int(days_ago.group(1)))).isoformat()

    # 完整日期
    matched = _FULL_DATE.match(text) or _COMPACT_DATE.match(text)
    if matched:
        year, month, day = (int(g) for g in matched.groups())
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return fallback

    # 省略年份的简写，按当年补全
    matched = _SHORT_DATE.match(text)
    if matched:
        month, day = (int(g) for g in matched.groups())
        try:
            return date(date.today().year, month, day).isoformat()
        except ValueError:
            return fallback

    return fallback


def date_range(days: int, end: str | None = None) -> tuple[str, str]:
    """生成最近 N 天的闭区间日期范围。

    参数:
        days: 天数，含结束日当天
        end: 结束日期，默认今天

    返回:
        (起始日期, 结束日期) 元组
    """
    end_date = date.fromisoformat(resolve_date(end) or today_str())
    span = max(int(days), 1) - 1
    return (end_date - timedelta(days=span)).isoformat(), end_date.isoformat()


def to_float(value, default: float | None = None) -> float | None:
    """宽松地把输入转成浮点数。

    会剥离常见单位后缀（g、kg、kcal、分钟等），
    因为口语输入和模板输出都可能带单位。
    """
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip()
    if not text:
        return default

    # 取出第一个数字，忽略前后的单位与说明文字
    matched = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    if not matched:
        return default
    try:
        return float(matched.group(0))
    except ValueError:
        return default


def to_int(value, default: int | None = None) -> int | None:
    """宽松地把输入转成整数。"""
    result = to_float(value, None)
    if result is None:
        return default
    return int(round(result))


def round_or_none(value: float | None, digits: int = 1) -> float | None:
    """对可空数值做四舍五入，None 原样返回。"""
    if value is None:
        return None
    return round(float(value), digits)


def age_from_birth_year(birth_year: int | None) -> int | None:
    """由出生年份推算当前年龄。"""
    if not birth_year:
        return None
    age = date.today().year - int(birth_year)
    return age if 0 < age < 130 else None
