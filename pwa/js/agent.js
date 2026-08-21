/* 浏览器直连版 Agent（替代 app/agent/* 后端）。
 * 调用 OpenAI 兼容接口（默认 SiliconFlow DeepSeek-V3），工具循环在浏览器内完成。
 * key 与对话历史存 localStorage，删除二次确认的 pending 队列也存 localStorage。
 */
(function () {
  "use strict";

  var HISTORY_KEY = "fit-chat-history";
  var PENDING_KEY = "fit-pending";
  var MAX_TOOL_ROUNDS = 3;

  // ---------------------------------------------------------------- 配置

  async function getLlmConfig() {
    var s = await FitDB.getSettings();
    return {
      api_key: (s.llm_api_key || "").trim(),
      base_url: (s.llm_base_url || "").trim() || "https://api.siliconflow.cn/v1",
      model: (s.llm_model || "").trim() || "deepseek-ai/DeepSeek-V3",
    };
  }

  // ---------------------------------------------------------------- 工具定义

  var TOOLS = [
    {
      type: "function",
      function: {
        name: "save_profile",
        description: "保存健康档案（身高/出生年/性别/活动水平/目标类型）。活动水平: sedentary久坐/light轻度/moderate中度/active高强度/very_active极高强度；目标: cut减脂/maintain维持/bulk增肌。",
        parameters: {
          type: "object",
          properties: {
            height: { type: "number", description: "身高 cm" },
            birth_year: { type: "integer", description: "出生年份，如 1999" },
            gender: { type: "string", enum: ["male", "female"] },
            activity_level: { type: "string", enum: ["sedentary", "light", "moderate", "active", "very_active"] },
            goal_type: { type: "string", enum: ["cut", "maintain", "bulk"] },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "record_body",
        description: "记录体重/体脂/腰围。date 可写今天/昨天/前天/YYYY-MM-DD，不写默认今天。",
        parameters: {
          type: "object",
          properties: {
            weight: { type: "number", description: "体重 kg" },
            body_fat: { type: "number", description: "体脂率 %" },
            waist: { type: "number", description: "腰围 cm" },
            date: { type: "string" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "record_diet",
        description: "记录一条饮食。date 可写口语（今天/昨天）或 YYYY-MM-DD，不写默认今天。",
        parameters: {
          type: "object",
          properties: {
            meal_type: { type: "string", enum: ["早餐", "午餐", "晚餐", "加餐"] },
            food_name: { type: "string" },
            amount: { type: "string" },
            calories: { type: "number" },
            protein: { type: "number" },
            fat: { type: "number" },
            carbs: { type: "number" },
            date: { type: "string" },
          },
          required: ["food_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "record_workout",
        description: "记录一次训练。date 可写口语（今天/昨天）或 YYYY-MM-DD，不写默认今天。",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", description: "部位/类型，如 胸/背/腿/肩/有氧/跑步" },
            duration_min: { type: "number" },
            calories: { type: "number" },
            note: { type: "string" },
            date: { type: "string" },
          },
          required: ["category"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "compute_goals",
        description: "按当前档案推算 BMR/TDEE/每日热量目标与三大宏量。档案不全会返回缺失项提示。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "query_records",
        description: "查询某天某类记录。record_type: diet饮食/workout训练/body身体。date 不写默认今天。",
        parameters: {
          type: "object",
          properties: {
            record_type: { type: "string", enum: ["diet", "workout", "body"] },
            date: { type: "string" },
          },
          required: ["record_type"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query_stats",
        description: "查询最近 N 天的统计汇总（摄入/消耗/体重趋势/部位分布）。",
        parameters: {
          type: "object",
          properties: { days: { type: "integer", description: "天数，默认 7" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "navigate_ui",
        description: "切换到页面视图。view: today今日/diet饮食/workout训练/body身体/stats统计/settings设置。用户说「打开/进入/查看/去/切到/分析」某页面时必须调用。",
        parameters: {
          type: "object",
          properties: {
            view: { type: "string", enum: ["today", "diet", "workout", "body", "stats", "settings"] },
            date: { type: "string" },
            days: { type: "integer" },
          },
          required: ["view"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "request_delete",
        description: "请求删除某些记录，生成二次确认卡片。summary 用一行文字描述要删的内容。",
        parameters: {
          type: "object",
          properties: {
            record_type: { type: "string", enum: ["diet", "workout", "body"] },
            ids: { type: "array", items: { type: "integer" }, description: "记录 id 列表" },
            summary: { type: "string" },
          },
          required: ["record_type", "ids", "summary"],
        },
      },
    },
  ];

  // ---------------------------------------------------------------- 提示词

  function systemPrompt(profile) {
    var complete = !FitNutrition.missingProfileFields(profile).length;
    var profileLine = complete
      ? "档案完整（身高 " + profile.height + "cm / 出生 " + profile.birth_year + " / " + profile.gender + " / " + profile.activity_level + " / " + profile.goal_type + "），不要再问建档问题。"
      : "档案不完整（缺：" + (FitNutrition.missingProfileFields(profile).join("、") || "未知") + "），用户要求建档或记录时优先引导补全。";
    return [
      "你是「健身记录助手」，一个本地健身记录应用里的对话助手。你通过工具读写数据，回复要简洁自然，不要啰嗦。",
      "",
      "当前档案状态：" + profileLine,
      "",
      "铁律：",
      "1. 用户给出新记录指令（吃了什么/练了什么/体重多少）后，必须调用对应 record_* 工具真实写入；没调工具绝不能说「已记录/已保存」。",
      "2. 用户说要建档/设目标，先引导补全身高、出生年份、性别、活动水平、目标类型，齐全后调 save_profile + compute_goals 播报结果。",
      "3. 删除操作：先查目标记录，再直接调 request_delete 生成二次确认卡片，不要只口头问。",
      "4. 用户说「打开/进入/查看/去/切到/分析」某个页面时，必须调 navigate_ui。",
      "5. 日期支持口语：今天/昨天/前天/明天 或 YYYY-MM-DD 或 N 天前。",
      "6. 查数据用 query_records / query_stats，分析时给出数字结论。",
      "7. 不要编造工具返回值；工具执行失败就如实说明。",
    ].join("\n");
  }

  // ---------------------------------------------------------------- 工具执行

  function describeRecord(recordType, row) {
    var parts = [row.date];
    if (recordType === "diet") {
      parts.push(row.meal_type, row.food_name);
      if (row.amount) parts.push(row.amount);
      if (row.calories != null) parts.push(Math.round(row.calories) + " kcal");
    } else if (recordType === "workout") {
      parts.push(row.category);
      if (row.duration_min != null) parts.push(Math.round(row.duration_min) + " min");
      if (row.calories != null) parts.push(Math.round(row.calories) + " kcal");
    } else {
      if (row.weight != null) parts.push("体重" + row.weight + "kg");
      if (row.body_fat != null) parts.push("体脂" + row.body_fat + "%");
      if (row.waist != null) parts.push("腰围" + row.waist + "cm");
    }
    return "#" + row.id + " " + parts.filter(Boolean).join(" · ");
  }

  async function runTool(name, args) {
    var profile, plan;
    switch (name) {
      case "save_profile":
        await FitDB.updateProfile(args);
        profile = await FitDB.getProfile();
        return "档案已保存：" + JSON.stringify(profile);
      case "record_body":
        await FitDB.addRecords("body", [Object.assign({}, args, { date: args.date || "今天" })]);
        return "已记录身体数据（日期：" + (FitUtils.resolveDate(args.date) || FitUtils.todayStr()) + "）";
      case "record_diet":
        if (!args.food_name) throw new Error("record_diet 缺少 food_name");
        await FitDB.addRecords("diet", [Object.assign({}, args, { date: args.date || "今天", source: "agent" })]);
        return "已记录饮食：" + args.food_name + (args.calories != null ? "（" + args.calories + " kcal）" : "");
      case "record_workout":
        if (!args.category) throw new Error("record_workout 缺少 category");
        await FitDB.addRecords("workout", [Object.assign({}, args, { date: args.date || "今天" })]);
        return "已记录训练：" + args.category + (args.duration_min != null ? "（" + args.duration_min + " min）" : "");
      case "compute_goals": {
        profile = await FitDB.getProfile();
        var missing = FitNutrition.missingProfileFields(profile);
        if (missing.length) {
          return "档案不完整，无法计算目标，缺少：" + missing.join("、") + "。请先补全档案。";
        }
        plan = FitNutrition.calcPlan(
          profile.latest_weight, profile.height, profile.age,
          profile.gender, profile.activity_level, profile.goal_type
        );
        await FitDB.updateGoals({
          bmr: plan.bmr, tdee: plan.tdee, daily_calories: plan.daily_calories,
          protein_g: plan.protein_g, fat_g: plan.fat_g, carbs_g: plan.carbs_g,
          target_weight: null, workout_days_per_week: null,
        });
        return plan.explain;
      }
      case "query_records": {
        var rows = await FitDB.listRecords(args.record_type, { date: args.date || "今天", limit: 20 });
        if (!rows.length) return "没有找到 " + (args.date || "今天") + " 的" + args.record_type + "记录";
        return rows.map(function (r) { return describeRecord(args.record_type, r); }).join("\n");
      }
      case "query_stats": {
        var days = Math.min(Math.max(parseInt(args.days, 10) || 7, 1), 90);
        var range = FitUtils.dateRange(days);
        var st = await FitDB.rangeStats(range[0], range[1]);
        var a = st.averages, t = st.totals;
        return [
          "近" + days + "天：日均摄入 " + (a.diet_calories ?? "—") + " kcal，日均训练消耗 " + (a.workout_calories ?? "—") + " kcal，",
          "训练天数 " + t.workout_days + "，平均体重 " + (a.weight ?? "—") + " kg，",
          "摄入/消耗趋势：" + JSON.stringify(st.series.diet_calories),
          "部位分布：" + JSON.stringify(st.category_minutes),
        ].join("\n");
      }
      case "navigate_ui":
        return "OK 已定位到页面" + args.view + (args.date ? "（日期 " + args.date + "）" : "");
      case "request_delete": {
        var id = "p" + Date.now();
        var pendingList = await getPending();
        pendingList.push({
          id: id,
          record_type: args.record_type,
          ids: Array.isArray(args.ids) ? args.ids.map(Number) : [],
          summary: args.summary || "删除 " + args.record_type + " 记录",
          created_at: FitUtils.nowStr(),
        });
        await setPending(pendingList);
        return "已生成删除确认卡片 pending_id=" + id + "，等待用户确认";
      }
      default:
        throw new Error("未知工具：" + name);
    }
  }

  // ---------------------------------------------------------------- pending 队列

  function getPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch (e) { return []; }
  }
  function setPending(list) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  }
  async function confirmPending(id) {
    var list = getPending();
    var item = list.filter(function (p) { return p.id === id; })[0];
    if (!item) throw new Error("找不到待确认操作");
    if (item.record_type && item.ids && item.ids.length) {
      await FitDB.softDelete(item.record_type, item.ids);
    }
    setPending(list.filter(function (p) { return p.id !== id; }));
    return item;
  }
  function cancelPending(id) {
    setPending(getPending().filter(function (p) { return p.id !== id; }));
  }

  // ---------------------------------------------------------------- 对话历史

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
  }
  function setHistory(messages) {
    // 只保留最近 40 条，避免 localStorage 膨胀
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-40)));
  }
  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
  }

  // ---------------------------------------------------------------- 对话主循环

  async function chat(message) {
    var cfg = await getLlmConfig();
    if (!cfg.api_key) {
      return { reply: "还没有配置 AI 接口：请在「设置」页填入 API Key（OpenAI 兼容接口，如 SiliconFlow）后使用。", pending: [], ui_actions: [], data_changed: false };
    }

    var profile = await FitDB.getProfile();
    var history = getHistory();
    var messages = [
      { role: "system", content: systemPrompt(profile) },
    ].concat(history).concat([{ role: "user", content: message }]);

    var dataChanged = false;
    var uiActions = [];
    var pendingCreated = [];

    for (var round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      var payload = {
        model: cfg.model,
        messages: messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.3,
      };
      var res = await fetch(cfg.base_url.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + cfg.api_key,
        },
        body: JSON.stringify(payload),
      });
      var data;
      try { data = await res.json(); } catch (e) { data = {}; }
      if (!res.ok) {
        var errMsg = (data && (data.error && data.error.message)) || ("HTTP " + res.status);
        throw new Error("AI 接口错误：" + errMsg);
      }

      var choice = data.choices && data.choices[0];
      var msg = choice && choice.message;
      if (!msg) throw new Error("AI 返回异常（无 choices）");

      messages.push(msg);

      var toolCalls = msg.tool_calls || [];
      if (!toolCalls.length) {
        // 无工具调用，本轮结束
        setHistory(messages.slice(1)); // 去掉 system，保留对话上下文
        return {
          reply: msg.content || "",
          pending: pendingCreated,
          ui_actions: uiActions,
          data_changed: dataChanged,
        };
      }

      for (var i = 0; i < toolCalls.length; i++) {
        var call = toolCalls[i];
        var fn = call.function || {};
        var name = fn.name || "";
        var argsText = fn.arguments || "{}";
        var args;
        try { args = JSON.parse(argsText); } catch (e) { args = {}; }

        var resultText;
        try {
          resultText = await runTool(name, args);
          if (["record_body", "record_diet", "record_workout", "save_profile", "compute_goals"].indexOf(name) >= 0) dataChanged = true;
          if (name === "navigate_ui") {
            uiActions.push({ type: "navigate", view: args.view, date: args.date, days: args.days });
          }
          if (name === "request_delete") {
            var m = resultText.match(/pending_id=([\w-]+)/);
            if (m) {
              var pl = getPending().filter(function (p) { return p.id === m[1]; })[0];
              pendingCreated.push({ id: pl.id, summary: pl.summary, records: [] });
            }
          }
        } catch (e) {
          resultText = "工具执行失败：" + e.message;
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      }
    }

    // 超轮数兜底
    setHistory(messages.slice(1));
    var last = messages[messages.length - 1];
    return {
      reply: (last && last.role === "assistant" && last.content) || "我已处理完，但没能给出最终回复，请再说一次。",
      pending: pendingCreated,
      ui_actions: uiActions,
      data_changed: dataChanged,
    };
  }

  window.FitAgent = {
    chat: chat,
    getPending: getPending,
    confirmPending: confirmPending,
    cancelPending: cancelPending,
    getHistory: getHistory,
    clearHistory: clearHistory,
    getLlmConfig: getLlmConfig,
  };
})();
