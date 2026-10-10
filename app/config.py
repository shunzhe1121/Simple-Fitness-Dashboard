"""应用配置。

所有可变参数集中在这里读取，LLM 凭据默认留空：
拿到 API 之后只需填写 .env，无需改动任何代码。
"""

from __future__ import annotations

import os
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

# ---- 佳明同步配置 ----
GARMIN_EMAIL = _text("GARMIN_EMAIL")
GARMIN_PASSWORD = _text("GARMIN_PASSWORD")

# 日报输出目录（MD 归档）
REPORTS_DIR = Path(_text("REPORTS_DIR", "data/reports"))
REPORTS_DIR = REPORTS_DIR if REPORTS_DIR.is_absolute() else BASE_DIR / REPORTS_DIR

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
