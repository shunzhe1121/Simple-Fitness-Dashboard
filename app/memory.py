"""AI 长期记忆。

两个本地 Markdown 文件构成记忆层，全部存在 data/memory/ 下：
- profile.md：用户画像（目标、偏好、伤病、忌口），基本不变，手工或让 AI 改；
- summary.md：长周期总结，日报生成时定期由 AI 把近期日报压缩续写。

记忆在 Agent 对话与日报生成时注入 prompt，属于用户自己的文件，
不依赖任何模型厂商，换模型可整体带走。
"""

from __future__ import annotations

from . import config

MEMORY_DIR = config.DB_PATH.parent / "memory"
PROFILE_FILE = MEMORY_DIR / "profile.md"
SUMMARY_FILE = MEMORY_DIR / "summary.md"

PROFILE_TEMPLATE = """# 个人画像

<!-- 目标、偏好、伤病、忌口等长周期信息。可手工编辑，
     也可以在 AI 对话里说"记住我喜欢..."，由 AI 提议更新。 -->

- 健身目标：增肌
- 饮食偏好：（待补充）
- 伤病/忌口：（待补充）
"""


def _ensure_dir() -> None:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)


def load_memory() -> str:
    """读取全部记忆内容，供注入 prompt。文件缺失时返回空串。"""
    parts = []
    for path in (PROFILE_FILE, SUMMARY_FILE):
        if path.exists():
            text = path.read_text(encoding="utf-8").strip()
            if text:
                parts.append(text)
    return "\n\n".join(parts)


def read_profile() -> str:
    _ensure_dir()
    if not PROFILE_FILE.exists():
        PROFILE_FILE.write_text(PROFILE_TEMPLATE, encoding="utf-8")
    return PROFILE_FILE.read_text(encoding="utf-8")


def write_profile(content: str) -> None:
    _ensure_dir()
    PROFILE_FILE.write_text(content, encoding="utf-8")


def read_summary() -> str:
    _ensure_dir()
    if SUMMARY_FILE.exists():
        return SUMMARY_FILE.read_text(encoding="utf-8")
    return ""


def write_summary(content: str) -> None:
    _ensure_dir()
    SUMMARY_FILE.write_text(content, encoding="utf-8")
