/* 本地 API 兼容层：把前端原有的 /api/* 请求分发到 IndexedDB/营养/解析/Agent。
 * 前端 app.js 的 this.api(path, body, method) 调用面保持不变。
 */
(function () {
  "use strict";

  function notFound(path) {
    return Promise.reject(new Error("本地模式不支持该接口：" + path));
  }

  async function handle(path, body, method) {
    var url = new URL(path, location.origin);
    var parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    var q = url.searchParams;

    if (parts.length < 2 || parts[0] !== "api") return notFound(path);
    var seg = parts.slice(1);

    // ---------------- 元信息
    if (seg.length === 1 && seg[0] === "meta" && method !== "POST") {
      var settings = await FitDB.getSettings();
      return {
        today: FitUtils.todayStr(),
        llm: { configured: !!(settings.llm_api_key || "").trim() },
        options: FitNutrition.options(),
        record_types: { diet: "饮食", workout: "训练", body: "身体" },
        doubao_prompt: FitParser.DOUBAO_PROMPT,
        chat_history_days: 30,
      };
    }

    // ---------------- 档案
    if (seg.length === 1 && seg[0] === "profile") {
      if (!method || method === "GET") return FitDB.getProfile();
      if (method === "PUT") return FitDB.updateProfile(body || {});
    }

    // ---------------- 目标
    if (seg.length === 1 && seg[0] === "goals") {
      if (!method || method === "GET") return FitDB.getGoals();
    }
    if (seg.length === 2 && seg[0] === "goals" && seg[1] === "calc") {
      // body: {weight, height, age, gender, activity_level, goal_type, target_weight, workout_days_per_week}
      var p = body || {};
      var weight = p.weight;
      if (weight === null || weight === undefined) {
        var prof = await FitDB.getProfile();
        weight = prof.latest_weight;
      }
      if ([weight, p.height, p.age].some(function (v) { return v === null || v === undefined || v === ""; })) {
        throw new Error("推算目标需要身高、体重、年龄，请先完善档案");
      }
      var plan = FitNutrition.calcPlan(weight, p.height, p.age, p.gender, p.activity_level, p.goal_type);
      await FitDB.updateGoals({
        bmr: plan.bmr, tdee: plan.tdee, daily_calories: plan.daily_calories,
        protein_g: plan.protein_g, fat_g: plan.fat_g, carbs_g: plan.carbs_g,
        target_weight: p.target_weight !== undefined ? p.target_weight : null,
        workout_days_per_week: p.workout_days_per_week !== undefined ? p.workout_days_per_week : null,
      });
      return { goals: await FitDB.getGoals(), plan: { explain: plan.explain } };
    }

    // ---------------- 单日汇总
    if (seg.length === 2 && seg[0] === "summary" && seg[1] === "daily") {
      return FitDB.dailySummary(q.get("date"));
    }

    // ---------------- 区间统计
    if (seg.length === 2 && seg[0] === "stats" && seg[1] === "range") {
      var days = parseInt(q.get("days"), 10) || 7;
      var range = FitUtils.dateRange(days);
      return FitDB.rangeStats(range[0], range[1]);
    }

    // ---------------- 记录
    if (seg[0] === "records") {
      var recordType = seg[1];
      if (!FitDB.RECORD_TYPES[recordType]) {
        throw new Error("未知的记录类型 " + recordType + "，可选：" + Object.keys(FitDB.RECORD_TYPES).join("、"));
      }
      // /api/records/{type}/trash
      if (seg.length === 3 && seg[2] === "trash") {
        return { records: await FitDB.listDeleted(recordType, parseInt(q.get("limit"), 10) || 50) };
      }
      // /api/records/{type}
      if (seg.length === 2) {
        if (!method || method === "GET") {
          return {
            records: await FitDB.listRecords(recordType, {
              date: q.get("date"),
              dateFrom: q.get("date_from"),
              dateTo: q.get("date_to"),
              limit: q.get("limit") ? parseInt(q.get("limit"), 10) : null,
            }),
          };
        }
        if (method === "POST") {
          var items = body && Array.isArray(body.records) ? body.records : [body];
          return { records: await FitDB.addRecords(recordType, items), count: items.length };
        }
      }
      // /api/records/{type}/{id}
      if (seg.length === 3) {
        var id = parseInt(seg[2], 10);
        if (method === "PUT") return FitDB.updateRecord(recordType, id, body || {});
        if (method === "DELETE") {
          var n = await FitDB.softDelete(recordType, [id]);
          return { deleted: n };
        }
      }
      // /api/records/{type}/{id}/restore
      if (seg.length === 4 && seg[3] === "restore") {
        await FitDB.restore(recordType, [parseInt(seg[2], 10)]);
        return { restored: 1 };
      }
    }

    // ---------------- 模板解析
    if (seg.length === 2 && seg[0] === "parse") {
      var text = (body && body.text) || "";
      var date = (body && body.date) || null;
      if (seg[1] === "preview") return FitParser.parse(text, date);
      if (seg[1] === "import") {
        var parsed = FitParser.parse(text, date);
        var savedMap = {};
        var total = 0;
        for (var t of ["diet", "workout", "body"]) {
          if (parsed[t] && parsed[t].length) {
            savedMap[t] = await FitDB.addRecords(t, parsed[t]);
            total += savedMap[t].length;
          }
        }
        if (!total) {
          throw new Error("没能解析出任何记录。" + (parsed.warnings || []).join("；"));
        }
        return { saved: savedMap, count: total, warnings: parsed.warnings, unparsed: parsed.unparsed };
      }
    }

    // ---------------- Agent 对话
    if (seg[0] === "agent") {
      if (seg.length === 2 && seg[1] === "history") {
        if (!method || method === "GET") return { messages: FitAgent.getHistory() };
        if (method === "DELETE") { FitAgent.clearHistory(); return { ok: true }; }
      }
      if (seg.length === 2 && seg[1] === "chat") {
        return FitAgent.chat((body && body.message) || "");
      }
    }

    // ---------------- 待确认队列
    if (seg.length === 1 && seg[0] === "pending") {
      return { pending: FitAgent.getPending().map(function (p) {
        return { id: p.id, summary: p.summary || "", records: [] };
      }) };
    }
    if (seg.length === 3 && seg[0] === "pending" && seg[2] === "confirm") {
      await FitAgent.confirmPending(seg[1]);
      return { ok: true };
    }
    if (seg.length === 3 && seg[0] === "pending" && seg[2] === "cancel") {
      FitAgent.cancelPending(seg[1]);
      return { ok: true };
    }

    // ---------------- 导入（导出由前端 Blob 直接生成，不走这里）
    if (seg.length === 1 && seg[0] === "import") {
      var data = (body && body.data) || null;
      var replace = !!(body && body.replace);
      return await FitDB.importAll(data, replace);
    }

    return notFound(path);
  }

  window.FitLocalApi = { handle: handle };
})();
