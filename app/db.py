"""SQLite 连接管理与建表。

每次操作开一条新连接，用完即关：单用户场景下开销可以忽略，
换来的是彻底规避 SQLite 的跨线程限制问题。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

from . import config

# 建表语句。三张记录表都带 deleted_at 做软删除，
# 误删之后还能从回收站找回来。
SCHEMA = """
CREATE TABLE IF NOT EXISTS diet_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    meal_type   TEXT,
    food_name   TEXT    NOT NULL,
    amount      TEXT,
    calories    REAL,
    protein     REAL,
    fat         REAL,
    carbs       REAL,
    source      TEXT    DEFAULT 'manual',
    note        TEXT,
    created_at  TEXT    NOT NULL,
    deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS workout_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    duration_min REAL,
    calories    REAL,
    note        TEXT,
    created_at  TEXT    NOT NULL,
    deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS body_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    weight      REAL,
    body_fat    REAL,
    waist       REAL,
    note        TEXT,
    created_at  TEXT    NOT NULL,
    deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS user_profile (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    height          REAL,
    birth_year      INTEGER,
    gender          TEXT,
    activity_level  TEXT,
    goal_type       TEXT,
    updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS goals (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    bmr                   REAL,
    tdee                  REAL,
    daily_calories        REAL,
    protein_g             REAL,
    fat_g                 REAL,
    carbs_g               REAL,
    target_weight         REAL,
    workout_days_per_week INTEGER,
    updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS pending_actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT    NOT NULL,
    record_type TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    summary     TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending',
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diet_date    ON diet_records (date);
CREATE INDEX IF NOT EXISTS idx_workout_date ON workout_records (date);
CREATE INDEX IF NOT EXISTS idx_body_date    ON body_records (date);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages (created_at);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """打开一条数据库连接，正常结束自动提交，异常自动回滚。"""
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """建表并写入单例行（个人资料与目标各只有一行）。"""
    with connect() as conn:
        conn.executescript(SCHEMA)
        conn.execute("INSERT OR IGNORE INTO user_profile (id) VALUES (1)")
        conn.execute("INSERT OR IGNORE INTO goals (id) VALUES (1)")


def query(sql: str, params: tuple = ()) -> list[dict]:
    """执行查询并返回字典列表。"""
    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def query_one(sql: str, params: tuple = ()) -> dict | None:
    """执行查询并返回首行，无结果时返回 None。"""
    with connect() as conn:
        row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def execute(sql: str, params: tuple = ()) -> int:
    """执行写入语句，返回新增行 id（非插入语句返回受影响行数）。"""
    with connect() as conn:
        cursor = conn.execute(sql, params)
        return cursor.lastrowid if cursor.lastrowid else cursor.rowcount
