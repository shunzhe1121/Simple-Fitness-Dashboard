"""LangGraph Agent 图。

刻意用显式 StateGraph 而不是 prebuilt 的封装，方便看清 agent-tools
这个循环本身：agent 节点决定要不要调工具，tools 节点执行，
结果回到 agent 节点继续判断，直到不再产生工具调用为止。

    entry -> agent -> (有 tool_calls?) -> tools -> agent -> ... -> END
"""

from __future__ import annotations

import json
import re
from datetime import date
from typing import Annotated, Any, TypedDict

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from .. import config, nutrition, repository
from .tools import MUTATING_TOOLS, TOOLS

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 单次对话内最多允许的图步数，防止工具调用陷入死循环
RECURSION_LIMIT = 16

# 懒加载的图实例
_graph = None

# 回复中声称执行了动作但实际没调工具时，用于检测的正则
_ACTION_CLAIM_RE = re.compile(
    r"已(记录|保存|设置|修改|删除|切换|计算|入库|写入|添加|更新|确认)"
    r"|已(经)?(帮您|为您|给你)?(记|存|写|算|删|改|加)"
)

# 最大重试次数（检测到空头承诺时补一轮工具调用）
_MAX_RETRIES = 1


class AgentUnavailable(RuntimeError):
    """LLM 未配置时抛出，由 API 层转成前端提示。"""


class AgentState(TypedDict):
    """图状态。add_messages 负责把每轮新消息累加进列表。"""

    messages: Annotated[list[BaseMessage], add_messages]


def graph_available() -> bool:
    """LLM 是否已配置。未配置时对话功能不可用，其余功能不受影响。"""
    return config.llm_configured()


def _build_llm():
    """构造 OpenAI 兼容的聊天模型并绑定工具。"""
    if not graph_available():
        raise AgentUnavailable(
            "LLM 尚未配置。在项目根目录的 .env 里填写 "
            "LLM_API_KEY、LLM_BASE_URL、LLM_MODEL 后重启服务即可启用对话。"
        )

    # 延迟导入，未装依赖时不影响其余功能
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        api_key=config.LLM_API_KEY,
        base_url=config.LLM_BASE_URL,
        model=config.LLM_MODEL,
        temperature=config.LLM_TEMPERATURE,
        timeout=60,
        max_retries=2,
    ).bind_tools(TOOLS)


def _system_prompt() -> str:
    """构造系统提示词，把当天日期和用户当前状态注入上下文。"""
    today = date.today()
    profile = repository.get_profile()
    goals = repository.get_goals()

    profile_text = ", ".join(
        f"{label}={value}"
        for label, value in (
            ("身高", profile.get("height")),
            ("年龄", profile.get("age")),
            ("性别", profile.get("gender")),
            ("活动水平", profile.get("activity_level")),
            ("目标类型", profile.get("goal_type")),
            ("最近体重", profile.get("latest_weight")),
        )
        if value
    ) or "尚未填写"

    goals_text = ", ".join(
        f"{label}={value}"
        for label, value in (
            ("每日热量", goals.get("daily_calories")),
            ("蛋白质", goals.get("protein_g")),
            ("脂肪", goals.get("fat_g")),
            ("碳水", goals.get("carbs_g")),
            ("目标体重", goals.get("target_weight")),
        )
        if value
    ) or "尚未设定"

    missing = nutrition.missing_profile_fields(profile)
    profile_status = "完整" if not missing else "缺 " + "、".join(missing)

    # 长期记忆（data/memory/ 下的 profile.md 与 summary.md）
    from .. import memory as memory_mod

    memory_text = memory_mod.load_memory()
    memory_block = (
        f"\n关于用户的长期记忆（用户自己的档案，可信）：\n{memory_text}\n"
        if memory_text
        else ""
    )

    return f"""你是「健身记录助手」这个网页程序的操作 Agent。你不只是聊天，
你能直接读写它的数据库、修改条目、切换界面。

今天是 {today.isoformat()}（{_WEEKDAYS[today.weekday()]}）。
用户资料：{profile_text}
当前目标：{goals_text}
档案状态：{profile_status}
{memory_block}

通用铁律：回复里凡是声称「已记录 / 已保存 / 已设置 / 已修改 / 已删除 / 已切换 / 已计算」
等动作，都必须由 tool_calls 真正执行过；只靠文字确认而 tool_calls 为空就是空头支票，
会让数据库和界面与用户预期不一致。建档（save_profile / record_body）、改设置、
推算目标（compute_goals）、记饮食/训练/体重、删除、跳转页面统统适用——
没有 tool_calls 就不要写对应的确认句。

工作准则：

零、首次建档引导（档案未完整时必须执行）
- 只要「档案状态」还写着「缺 …」，而用户没有在说具体的记录或查询，就优先引导建立档案：
  依次要 身高、体重、年龄（或出生年份）、性别、活动水平、目标（减脂/维持/增肌）。
- 身高、年龄、性别、活动水平、目标用 save_profile 写入；体重用 record_body 记录
  （body 记录会同步更新档案里的「最新体重」，算每日目标依赖它，不能漏）。
- 用户一句话给多项时，把 save_profile / record_body 一起调完，不要攒。
- 关键规则：档案被写到完整的那一刻（含目标），必须在本轮里紧接着调 compute_goals
  算出每日目标（热量、蛋白、脂肪、碳水），并把数字写进回复里。
  严禁只回"我帮您算一下 / 现在计算"而不调 compute_goals——那是空头承诺，
  会让用户以为已经算好但实际 goals.tdee 仍为空、缺口算不出来。
- 档案已完整时，绝不再追问这些基础信息，直接处理记录/查询/分析需求。
- 若用户发来的是食物识别模板或明确的「记一条…」指令，先按正常流程处理记录，不必打断去建档。

一、输入判断
- 文本里含 ### 分隔和「食物: xxx」这类键值对，说明是从豆包识图复制来的模板，
  一律调 import_pasted_template 并把原文整段传进去，不要自己拆解析。
- 用户口语描述吃了什么（如「中午两个鸡蛋一碗粥」），调 record_diet。
  营养数据你按常见食物成分估算，注意是按实际分量算，不是每 100g 的值。
- 用户描述训练（如「今天练胸 40 分钟消耗 300 卡」），调 record_workout。
  训练只记部位、时长、消耗三项。用户没说消耗就留空，不要编数字。
- 用户报体重体脂（如「我今天 73kg」），调 record_body。

- 每条新的记录指令都必须重新调用对应工具，不要因为历史里出现过类似记录就当作已经记过；
  没调用工具就绝不要说「已记录 / 已保存」，那会误导用户。

二、日期
- 用户不说日期就是今天，工具的 date 参数留空即可。
- 「昨天」「前天」「3-15」这类写法原样传给工具，它自己会解析。

三、删除
- 删除一律调 request_delete(record_type, date=今天 / 或 record_ids / 或 keyword)，它自己会
  列出候选条目并在前端生成「确认卡片」，不会真删。
- 不要先调 query_records 再口头问「确认吗」——那不会产生确认卡片；request_delete 本身就是
  请求确认的动作。调用后只需告诉用户准备删哪几条、等他在卡片上点确认即可，不要反复调用。

四、界面
- 用户指令里出现「打开 / 进入 / 查看 / 去 / 切到 / 分析 + 某页面」时，【必须】调用
  navigate_ui(view=对应页面)，即使你也能用文字回答，也不能只描述要切换而不调工具。
- 允许 view 取值：today(今日)、diet(饮食)、workout(训练)、body(身体)、stats(统计)、settings(设置)。
- 做分析类回答时，先用 daily_summary / range_stats 取真实数据，再切页面并给结论。

五、分析
- 先用 daily_summary 或 range_stats 拿到真实数据，再基于数据说话，不要凭空评价。
- 目标缺失时可用 compute_goals 推算，但身高、年龄、性别缺哪项就问用户，不要假设。

六、回复风格
- 简体中文，简洁直接。记录成功就一句话确认关键数字，不要复述整段参数。
- 不确定的地方直接问，别猜。
"""


def _agent_node(state: AgentState) -> dict:
    """agent 节点：把对话丢给 LLM，让它决定回话还是调工具。"""
    llm = _build_llm()
    response = llm.invoke([SystemMessage(content=_system_prompt()), *state["messages"]])
    return {"messages": [response]}


def _route(state: AgentState) -> str:
    """条件边：还有工具要调就进 tools，否则结束本轮。"""
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and getattr(last, "tool_calls", None):
        return "tools"
    return END


def _get_graph():
    """编译并缓存图实例。"""
    global _graph
    if _graph is None:
        builder = StateGraph(AgentState)
        builder.add_node("agent", _agent_node)
        builder.add_node("tools", ToolNode(TOOLS))
        builder.set_entry_point("agent")
        builder.add_conditional_edges("agent", _route, {"tools": "tools", END: END})
        builder.add_edge("tools", "agent")
        _graph = builder.compile()
    return _graph


def _restore_history(rows: list[dict]) -> list[BaseMessage]:
    """把库里的对话历史还原成 LangChain 消息。

    只还原 user 和 assistant 两种角色：工具调用的中间过程不入库，
    避免历史里出现悬空的 tool_call 导致模型报错。
    """
    messages: list[BaseMessage] = []
    for row in rows:
        content = row.get("content") or ""
        if not content:
            continue
        if row.get("role") == "user":
            messages.append(HumanMessage(content=content))
        elif row.get("role") == "assistant":
            messages.append(AIMessage(content=content))
    return messages


def _collect_tool_results(messages: list[BaseMessage]) -> dict:
    """从执行结果里提取界面指令、数据变更标记和待确认项。

    先扫 AIMessage 建立 tool_call_id 到工具名的映射，
    再逐条读 ToolMessage 的返回 JSON。
    """
    name_by_call_id: dict[str, str] = {}
    for message in messages:
        if isinstance(message, AIMessage):
            for call in getattr(message, "tool_calls", None) or []:
                call_id = call.get("id")
                if call_id:
                    name_by_call_id[call_id] = call.get("name", "")

    ui_actions: list[dict] = []
    pending: list[dict] = []
    called: list[str] = []

    for message in messages:
        if not isinstance(message, ToolMessage):
            continue

        tool_name = getattr(message, "name", None) or name_by_call_id.get(
            message.tool_call_id, ""
        )
        called.append(tool_name)

        try:
            payload: Any = json.loads(message.content)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue

        if isinstance(payload.get("ui_action"), dict):
            ui_actions.append(payload["ui_action"])

        if payload.get("need_confirm") and payload.get("pending_id"):
            pending.append(
                {
                    "id": payload["pending_id"],
                    "summary": payload.get("summary") or payload.get("message") or "",
                    "records": payload.get("records") or [],
                }
            )

    return {
        "ui_actions": ui_actions,
        "pending": pending,
        "data_changed": any(name in MUTATING_TOOLS for name in called),
        "tools_called": called,
    }


def chat(message: str, history_limit: int = 20) -> dict:
    """跑一轮对话。

    参数:
        message: 用户输入
        history_limit: 带入上下文的历史条数

    返回:
        含 reply、ui_actions、pending、data_changed、tools_called 的字典
    """
    text = (message or "").strip()
    if not text:
        raise ValueError("消息内容为空")

    if not graph_available():
        raise AgentUnavailable(
            "LLM 尚未配置。在项目根目录的 .env 里填写 "
            "LLM_API_KEY、LLM_BASE_URL、LLM_MODEL 后重启服务即可启用对话。"
        )

    history = _restore_history(repository.list_chat_messages(history_limit))
    original_text = text  # 保留用户原始输入，兜底解析要用

    for attempt in range(_MAX_RETRIES + 1):
        initial = {"messages": [*history, HumanMessage(content=text)]}
        result = _get_graph().invoke(initial, config={"recursion_limit": RECURSION_LIMIT})
        messages = result["messages"]

        # 取最后一条不含工具调用的 AI 回复作为正式答复
        reply = ""
        for message_item in reversed(messages):
            if isinstance(message_item, AIMessage) and not getattr(
                message_item, "tool_calls", None
            ):
                reply = message_item.content or ""
                break
        if isinstance(reply, list):
            reply = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in reply
            )

        collected = _collect_tool_results(messages)

        # ---- 空头承诺检测：回复声称执行了动作但没调任何写入工具 ----
        has_mutating = any(n in MUTATING_TOOLS for n in collected["tools_called"])
        claims_action = bool(reply and _ACTION_CLAIM_RE.search(reply))

        if claims_action and not has_mutating:
            if attempt < _MAX_RETRIES:
                # 只追加本轮新增消息（不含旧历史，避免重复膨胀上下文）
                history.extend(messages[len(history):])
                # 追加一条系统提醒，强制模型下一轮必须调工具
                text = (
                    f"[系统检测] 你上一条回复声称已执行操作（「{reply[:80]}…」）"
                    "但实际没有调用任何写入工具。这会导致数据库与用户预期不一致。\n"
                    "请立即调用对应工具完成实际写入，不要只给文字确认。"
                )
                continue

            # ---- 重试仍失败：本地规则兜底，直接把用户输入里的记录写进库 ----
            fallback = _fallback_record(original_text)
            if fallback:
                collected["data_changed"] = True
                collected["tools_called"].append("fallback_local_record")
                reply = f"{reply}\n\n（检测到刚才的操作未真正写入，已自动补录）\n{fallback}"

        # 正常返回或重试耗尽
        repository.add_chat_message("user", message)
        if reply:
            repository.add_chat_message("assistant", reply)
        repository.prune_chat_messages(config.CHAT_HISTORY_DAYS)

        return {"reply": reply or "（本轮没有文字回复）", **collected}

    # 不应该到达这里，但做兜底
    return {"reply": reply or "（处理异常）", **collected}


def _fallback_record(text: str) -> str | None:
    """本地规则兜底：从用户原始输入里提取训练/饮食/体重记录并直接入库。

    这是最后一道防线，防止模型编造「已记录」而数据库为空。
    目前覆盖三类最常用的口语输入：
        - 训练：「练背 40 分钟 200 卡」「今天跑步30分钟」
        - 饮食：「吃了两个鸡蛋一碗粥 300大卡」
        - 体重：「今天 73kg」
    解析失败或不需要入库时返回 None。
    """
    import re as _re

    original = text
    lines: list[str] = []
    changed = False

    # 卡路里匹配：兼容「200卡」「200大卡」「消耗卡路里200」两种语序
    def _calories(s: str) -> float | None:
        m = _re.search(r"(\d+(?:\.\d+)?)\s*(?:千?卡|大卡|kcal|卡路里)", s, _re.I)
        if m:
            return float(m.group(1))
        m = _re.search(r"(?:千?卡|大卡|kcal|卡路里)\s*(\d+(?:\.\d+)?)", s, _re.I)
        return float(m.group(1)) if m else None

    # ---- 训练记录 ----
    # 训练关键词 + 分钟数（可选）+ 卡路里（可选）
    workout_keywords = [
        "练胸", "练背", "练腿", "练肩", "练臂", "练腹", "练核心", "跑步", "游泳",
        "骑行", "跳绳", "有氧", "力量", "深蹲", "卧推", "硬拉", "引体", "划船",
        "推举", "弯举", "卷腹", "平板支撑", "快走", "椭圆机", "划船机",
    ]
    for kw in workout_keywords:
        if kw in original:
            duration = _re.search(r"(\d+)\s*(?:分钟|分|min)", original)
            calories = _calories(original)
            try:
                saved = repository.add_record(
                    "workout",
                    {
                        "category": kw,
                        "duration_min": float(duration.group(1)) if duration else None,
                        "calories": calories,
                        "date": None,
                        "note": None,
                    },
                )
                lines.append(repository.describe_record("workout", saved))
                changed = True
            except repository.RepositoryError:
                return None
            break

    # ---- 饮食记录 ----
    if "吃" in original and not changed:
        calories = _calories(original)
        # 提取「吃了X」或「吃了X和Y」里的食物名
        food_match = _re.search(r"吃了\s*(.+?)(?:，|,|。|$)", original)
        if food_match:
            food_name = food_match.group(1).strip()
            # 去掉末尾的数字/单位尾巴
            food_name = _re.sub(r"[\d\s]*[千卡大卡kcal卡路里]+$", "", food_name).strip()
            try:
                saved = repository.add_record(
                    "diet",
                    {
                        "food_name": food_name,
                        "amount": None,
                        "calories": calories,
                        "protein": None,
                        "fat": None,
                        "carbs": None,
                        "meal_type": None,
                        "date": None,
                        "note": "助手自动补录",
                        "source": "estimate",
                    },
                )
                lines.append(repository.describe_record("diet", saved))
                changed = True
            except repository.RepositoryError:
                return None

    # ---- 体重记录 ----
    if not changed:
        weight_match = _re.search(r"(\d+(?:\.\d+)?)\s*(?:kg|公斤|千克)", original, _re.I)
        if weight_match:
            try:
                saved = repository.add_record(
                    "body",
                    {
                        "weight": float(weight_match.group(1)),
                        "body_fat": None,
                        "waist": None,
                        "date": None,
                        "note": None,
                    },
                )
                lines.append(repository.describe_record("body", saved))
                changed = True
            except repository.RepositoryError:
                return None

    return "\n".join(lines) if changed else None
