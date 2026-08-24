/* 本地数据层（移植自 app/repository.py）：IndexedDB 存储 + 汇总/统计查询。
 * 记录统一存在 records store，用 type 字段区分三类；软删除用 deletedAt 标记。
 */
(function () {
  "use strict";

  var DB_NAME = "fit-pwa";
  var DB_VERSION = 1;

  var RECORD_TYPES = {
    diet: { label: "饮食", fields: ["date", "meal_type", "food_name", "amount", "calories", "protein", "fat", "carbs", "source", "note"], numeric: ["calories", "protein", "fat", "carbs"], required: ["food_name"] },
    workout: { label: "训练", fields: ["date", "category", "duration_min", "calories", "note"], numeric: ["duration_min", "calories"], required: ["category"] },
    body: { label: "身体", fields: ["date", "weight", "body_fat", "waist", "note"], numeric: ["weight", "body_fat", "waist"], required: [] },
  };

  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("records")) {
          var store = db.createObjectStore("records", { keyPath: "id", autoIncrement: true });
          store.createIndex("byType", "type");
          store.createIndex("typeDate", ["type", "date"]);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(db, storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }
  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }
  function getAll(store) {
    return reqToPromise(store.getAll());
  }
  function put(store, value) {
    return reqToPromise(store.put(value));
  }
  function get(store, key) {
    return reqToPromise(store.get(key));
  }
  function del(store, key) {
    return reqToPromise(store.delete(key));
  }

  // ---------------------------------------------------------------- 通用 kv

  async function kvGet(key, def) {
    var db = await openDB();
    var v = await get(tx(db, "kv", "readonly"), key);
    return v === undefined ? def : v.value;
  }
  async function kvSet(key, value) {
    var db = await openDB();
    await put(tx(db, "kv", "readwrite"), { key: key, value: value });
  }

  // ---------------------------------------------------------------- 归一化

  function normalizeRecord(recordType, data) {
    var meta = RECORD_TYPES[recordType];
    if (!meta) throw new Error("未知的记录类型 " + recordType + "，可选：" + Object.keys(RECORD_TYPES).join("、"));
    var cleaned = {};
    meta.fields.forEach(function (field) {
      if (!(field in data)) return;
      var value = data[field];
      if (field === "date") cleaned[field] = FitUtils.resolveDate(value);
      else if (meta.numeric.indexOf(field) >= 0) cleaned[field] = FitUtils.toFloat(value);
      else cleaned[field] = (value === null || value === undefined) ? null : (String(value).trim() || null);
    });
    if (!cleaned.date) cleaned.date = FitUtils.todayStr();
    meta.required.forEach(function (field) {
      if (!cleaned[field]) throw new Error(meta.label + "记录缺少必填字段：" + field);
    });
    return cleaned;
  }

  // ---------------------------------------------------------------- 记录 CRUD

  async function addRecords(recordType, items) {
    if (!items || !items.length) throw new Error("没有可写入的记录");
    var db = await openDB();
    var saved = [];
    for (var i = 0; i < items.length; i++) {
      var cleaned = normalizeRecord(recordType, items[i]);
      cleaned.type = recordType;
      cleaned.createdAt = FitUtils.nowStr();
      cleaned.deletedAt = null;
      var id = await put(tx(db, "records", "readwrite"), cleaned);
      var full = Object.assign({ id: id }, cleaned);
      saved.push(full);
    }
    return saved;
  }

  async function updateRecord(recordType, recordId, fields) {
    var db = await openDB();
    var store = tx(db, "records", "readwrite");
    var row = await get(store, recordId);
    if (!row) throw new Error("找不到 id=" + recordId + " 的" + (RECORD_TYPES[recordType] || {}).label + "记录");

    var meta = RECORD_TYPES[recordType];
    var updates = {};
    Object.keys(fields).forEach(function (field) {
      if (meta.fields.indexOf(field) < 0) return;
      var value = fields[field];
      if (field === "date") updates[field] = FitUtils.resolveDate(value);
      else if (meta.numeric.indexOf(field) >= 0) updates[field] = FitUtils.toFloat(value);
      else updates[field] = (value === null || value === undefined) ? null : (String(value).trim() || null);
    });
    if (!Object.keys(updates).length) throw new Error("没有需要更新的字段");

    var merged = Object.assign({}, row, updates);
    await put(store, merged);
    return merged;
  }

  async function listRecords(recordType, opts) {
    opts = opts || {};
    var db = await openDB();
    var all = await getAll(tx(db, "records", "readonly"));
    var rows = all.filter(function (r) {
      if (r.type !== recordType) return false;
      if (!opts.includeDeleted && r.deletedAt) return false;
      if (opts.date) { if (r.date !== FitUtils.resolveDate(opts.date)) return false; }
      else {
        if (opts.dateFrom && r.date < FitUtils.resolveDate(opts.dateFrom)) return false;
        if (opts.dateTo && r.date > FitUtils.resolveDate(opts.dateTo)) return false;
      }
      return true;
    });
    rows.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
    if (opts.limit && rows.length > opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  }

  async function softDelete(recordType, ids) {
    var db = await openDB();
    var store = tx(db, "records", "readwrite");
    var count = 0;
    for (var i = 0; i < ids.length; i++) {
      var row = await get(store, ids[i]);
      if (row && row.type === recordType && !row.deletedAt) {
        row.deletedAt = FitUtils.nowStr();
        await put(store, row);
        count++;
      }
    }
    return count;
  }

  async function restore(recordType, ids) {
    var db = await openDB();
    var store = tx(db, "records", "readwrite");
    var count = 0;
    for (var i = 0; i < ids.length; i++) {
      var row = await get(store, ids[i]);
      if (row && row.type === recordType) {
        row.deletedAt = null;
        await put(store, row);
        count++;
      }
    }
    return count;
  }

  async function listDeleted(recordType, limit) {
    var db = await openDB();
    var all = await getAll(tx(db, "records", "readonly"));
    var rows = all.filter(function (r) { return r.type === recordType && r.deletedAt; });
    rows.sort(function (a, b) { return String(b.deletedAt).localeCompare(String(a.deletedAt)); });
    if (limit && rows.length > limit) rows = rows.slice(0, limit);
    return rows;
  }

  async function latestWeight() {
    var db = await openDB();
    var all = await getAll(tx(db, "records", "readonly"));
    var rows = all.filter(function (r) { return r.type === "body" && !r.deletedAt && r.weight !== null && r.weight !== undefined; });
    rows.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
    return rows.length ? rows[0].weight : null;
  }

  // ---------------------------------------------------------------- 档案与目标

  async function getProfile() {
    var p = await kvGet("profile", {}) || {};
    p.age = FitUtils.ageFromBirthYear(p.birth_year);
    p.latest_weight = await latestWeight();
    return p;
  }

  async function updateProfile(fields) {
    var p = await kvGet("profile", {}) || {};
    var allowed = { height: "num", birth_year: "int", gender: "str", activity_level: "str", goal_type: "str" };
    Object.keys(allowed).forEach(function (field) {
      if (!(field in fields)) return;
      var value = fields[field];
      if (allowed[field] === "num") p[field] = FitUtils.toFloat(value);
      else if (allowed[field] === "int") p[field] = FitUtils.toInt(value);
      else p[field] = (value === null || value === undefined) ? null : (String(value).trim() || null);
    });
    p.updatedAt = FitUtils.nowStr();
    await kvSet("profile", p);
    return getProfile();
  }

  async function getGoals() {
    return (await kvGet("goals", {})) || {};
  }

  async function updateGoals(fields) {
    var g = (await kvGet("goals", {})) || {};
    var allowed = ["bmr", "tdee", "daily_calories", "protein_g", "fat_g", "carbs_g", "target_weight", "workout_days_per_week"];
    allowed.forEach(function (field) {
      if (!(field in fields)) return;
      var value = fields[field];
      g[field] = field === "workout_days_per_week" ? FitUtils.toInt(value) : FitUtils.toFloat(value);
    });
    g.updatedAt = FitUtils.nowStr();
    await kvSet("goals", g);
    return g;
  }

  // ---------------------------------------------------------------- 汇总统计

  async function dailySummary(date) {
    var day = FitUtils.resolveDate(date);
    var dietRows = await listRecords("diet", { date: day });
    var workoutRows = await listRecords("workout", { date: day });
    var bodyRows = await listRecords("body", { date: day });

    function sum(rows, field) { return rows.reduce(function (a, r) { return a + (r[field] || 0); }, 0); }

    var dietTotal = {
      calories: sum(dietRows, "calories"),
      protein: sum(dietRows, "protein"),
      fat: sum(dietRows, "fat"),
      carbs: sum(dietRows, "carbs"),
      count: dietRows.length,
    };
    var workoutTotal = {
      duration_min: sum(workoutRows, "duration_min"),
      calories: sum(workoutRows, "calories"),
      count: workoutRows.length,
    };
    var latestBody = bodyRows.length ? bodyRows[0] : null;

    var goals = await getGoals();
    var tdee = goals.tdee;
    if (tdee === null || tdee === undefined) {
      var profile = await getProfile();
      if (!FitNutrition.missingProfileFields(profile).length) {
        var plan = FitNutrition.calcPlan(
          profile.latest_weight, profile.height, profile.age,
          profile.gender, profile.activity_level, profile.goal_type
        );
        tdee = plan.tdee;
      }
    }

    var deficit = null, deficitBand = null;
    if (tdee !== null && tdee !== undefined) {
      var net = dietTotal.calories - workoutTotal.calories;
      deficit = Math.round((tdee - net) * 10) / 10;
      deficitBand = FitNutrition.classifyDeficit(deficit);
    }

    var dailyCalories = goals.daily_calories;
    var effectiveTarget = null;
    if (dailyCalories) effectiveTarget = Math.round((dailyCalories + workoutTotal.calories) * 10) / 10;

    return {
      date: day,
      tdee: tdee,
      deficit: deficit,
      deficit_band: deficitBand,
      target_calories: effectiveTarget,
      diet: { total: dietTotal, records: dietRows },
      workout: { total: workoutTotal, records: workoutRows },
      body: latestBody,
      goals: goals,
    };
  }

  async function rangeStats(dateFrom, dateTo) {
    var start = FitUtils.resolveDate(dateFrom);
    var end = FitUtils.resolveDate(dateTo);
    var dietRows = await listRecords("diet", { dateFrom: start, dateTo: end });
    var workoutRows = await listRecords("workout", { dateFrom: start, dateTo: end });
    var bodyRows = await listRecords("body", { dateFrom: start, dateTo: end });

    // 枚举区间内每一天
    var days = [];
    var sp = start.split("-"), ep = end.split("-");
    var cursor = new Date(+sp[0], +sp[1] - 1, +sp[2]);
    var stop = new Date(+ep[0], +ep[1] - 1, +ep[2]);
    while (cursor <= stop) {
      days.push(cursor.getFullYear() + "-" + String(cursor.getMonth() + 1).padStart(2, "0") + "-" + String(cursor.getDate()).padStart(2, "0"));
      cursor.setDate(cursor.getDate() + 1);
    }

    function accumulate(rows, field) {
      var bucket = {};
      rows.forEach(function (r) { bucket[r.date] = (bucket[r.date] || 0) + (r[field] || 0); });
      return bucket;
    }
    var dietCal = accumulate(dietRows, "calories");
    var dietProtein = accumulate(dietRows, "protein");
    var dietFat = accumulate(dietRows, "fat");
    var dietCarbs = accumulate(dietRows, "carbs");
    var workoutCal = accumulate(workoutRows, "calories");
    var workoutMin = accumulate(workoutRows, "duration_min");

    var weightByDay = {};
    var sortedBody = bodyRows.slice().sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
    sortedBody.forEach(function (r) {
      if (r.weight !== null && r.weight !== undefined) weightByDay[r.date] = r.weight;
    });

    var series = {
      days: days,
      diet_calories: days.map(function (d) { return Math.round((dietCal[d] || 0) * 10) / 10; }),
      protein: days.map(function (d) { return Math.round((dietProtein[d] || 0) * 10) / 10; }),
      fat: days.map(function (d) { return Math.round((dietFat[d] || 0) * 10) / 10; }),
      carbs: days.map(function (d) { return Math.round((dietCarbs[d] || 0) * 10) / 10; }),
      workout_calories: days.map(function (d) { return Math.round((workoutCal[d] || 0) * 10) / 10; }),
      workout_minutes: days.map(function (d) { return Math.round((workoutMin[d] || 0) * 10) / 10; }),
      weight: days.map(function (d) { return weightByDay[d] !== undefined ? weightByDay[d] : null; }),
    };

    function average(values, onlyPositive) {
      var pool = values.filter(function (v) { return v !== null && v !== undefined && (v > 0 || !onlyPositive); });
      return pool.length ? Math.round((pool.reduce(function (a, b) { return a + b; }, 0) / pool.length) * 10) / 10 : null;
    }

    var categoryMinutes = {};
    workoutRows.forEach(function (r) {
      var key = r.category || "未分类";
      categoryMinutes[key] = (categoryMinutes[key] || 0) + (r.duration_min || 0);
    });

    var goals = await getGoals();
    var avgCalories = average(series.diet_calories, true);
    var targetCalories = goals.daily_calories;

    // 宏量热量占比（蛋白 4 / 脂肪 9 / 碳水 4 kcal 每克），统计页环形图用
    var macroShare = {
      protein_share: Math.round(dietRows.reduce(function (a, r) { return a + (r.protein || 0); }, 0) * 4 * 10) / 10,
      fat_share: Math.round(dietRows.reduce(function (a, r) { return a + (r.fat || 0); }, 0) * 9 * 10) / 10,
      carbs_share: Math.round(dietRows.reduce(function (a, r) { return a + (r.carbs || 0); }, 0) * 4 * 10) / 10,
    };

    return {
      date_from: start,
      date_to: end,
      series: series,
      averages: {
        diet_calories: avgCalories,
        protein: average(series.protein, true),
        fat: average(series.fat, true),
        carbs: average(series.carbs, true),
        workout_calories: average(series.workout_calories, true),
        workout_minutes: average(series.workout_minutes, true),
        weight: average(series.weight, false),
      },
      totals: {
        diet_calories: Math.round(series.diet_calories.reduce(function (a, b) { return a + b; }, 0) * 10) / 10,
        workout_calories: Math.round(series.workout_calories.reduce(function (a, b) { return a + b; }, 0) * 10) / 10,
        workout_minutes: Math.round(series.workout_minutes.reduce(function (a, b) { return a + b; }, 0) * 10) / 10,
        workout_days: Object.keys(workoutRows.reduce(function (m, r) { m[r.date] = 1; return m; }, {})).length,
        diet_records: dietRows.length,
      },
      category_minutes: categoryMinutes,
      macro_share: macroShare,
      goal_gap: (avgCalories !== null && targetCalories) ? Math.round((avgCalories - targetCalories) * 10) / 10 : null,
      goals: goals,
    };
  }

  // ---------------------------------------------------------------- 备份

  // 设备唯一标识：持久化到 kv。导出时写入 device_id，导入时据此判断
  // 备份是否来自本机 —— 同设备回导用「type:id」兜底去重（本地手动添加的
  // 记录没有 sourceTypeId），跨设备迁移仍走 sourceTypeId 逻辑（避免不同
  // 设备的自增 id 撞车被误判为重复而跳过）。
  async function getDeviceId() {
    var id = await kvGet("device_id", "");
    if (!id) {
      id = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      await kvSet("device_id", id);
    }
    return id;
  }

  async function exportAll() {
    var db = await openDB();
    var records = await getAll(tx(db, "records", "readonly"));
    var profile = await kvGet("profile", {});
    var goals = await kvGet("goals", {});
    var settings = await kvGet("settings", {});
    return {
      app: "fit-pwa",
      version: 1,
      device_id: await getDeviceId(),
      exported_at: FitUtils.nowStr(),
      profile: profile,
      goals: goals,
      settings: settings,
      records: records,
    };
  }

  async function importAll(data, replace) {
    if (!data || typeof data !== "object") throw new Error("导入数据格式不正确");
    var db = await openDB();

    // 兼容两种导入格式：
    // 1) PWA 原生格式：{ records: [{type, ...}] }
    // 2) 桌面 FastAPI 版导出格式：{ diet: [...], workout: [...], body: [...] }（分组数组）
    var records;
    if (Array.isArray(data.records)) {
      records = data.records;
    } else {
      records = [];
      ["diet", "workout", "body"].forEach(function (t) {
        (Array.isArray(data[t]) ? data[t] : []).forEach(function (r) {
          records.push(Object.assign({ type: t }, r));
        });
      });
    }
    // 校验记录类型
    records.forEach(function (r) {
      if (!RECORD_TYPES[r.type]) throw new Error("导入数据包含未知记录类型：" + r.type);
    });

    // 去重键 = 类型 + 原 id（sourceTypeId）。桌面版各类型独立自增 id，跨类型 id 会重复，
    // 不能只看 id；手机版自己新增的记录没有 sourceTypeId，靠「id 是否被占用」来避免覆盖。
    // 本机导出的备份回导时：本地记录（含手动添加的无 sourceTypeId 记录）用「type:本地id」
    // 兜底注册进 sourceMap，否则导出→导入同一份数据会整批重复。
    var sourceMap = {};
    if (!replace) {
      var existingAll = await getAll(tx(db, "records", "readonly"));
      var sameDevice = !!(data.device_id && data.device_id === await getDeviceId());
      existingAll.forEach(function (r) {
        if (r.sourceTypeId) sourceMap[r.sourceTypeId] = r;
        if (sameDevice && r.id !== undefined && r.id !== null) sourceMap[r.type + ":" + r.id] = r;
      });
    }

    if (replace) {
      // 全量替换：清空后重建（保留自增位）
      var storeAll = tx(db, "records", "readwrite");
      var all = await getAll(storeAll);
      for (var i = 0; i < all.length; i++) await del(storeAll, all[i].id);
    }

    // 写入记录（归一化 + 保留原 id 与 deletedAt）
    var store = tx(db, "records", "readwrite");
    var added = 0;
    for (var j = 0; j < records.length; j++) {
      var raw = records[j];
      var cleaned = normalizeRecord(raw.type, raw);
      cleaned.type = raw.type;
      cleaned.createdAt = raw.createdAt || FitUtils.nowStr();
      cleaned.deletedAt = raw.deletedAt || null;

      var sourceKey = (raw.id !== undefined && raw.id !== null) ? (raw.type + ":" + raw.id) : null;
      if (sourceKey) {
        cleaned.sourceTypeId = sourceKey;
        var existing = sourceMap[sourceKey];
        if (existing) {
          // 同类型同原 id：追加模式下未删除的跳过（真正的重复）；已删除则复用 id 恢复
          if (!replace && !existing.deletedAt) continue;
          cleaned.id = existing.id;
        } else {
          // 无同源记录：若 id 已被任意记录占用（跨类型 id 冲突或本地记录撞 id），重新自增
          var idHolder = await get(store, raw.id);
          if (idHolder) delete cleaned.id;
          else cleaned.id = raw.id;
        }
      }
      await put(store, cleaned);
      added++;
    }

    if (data.profile) await kvSet("profile", data.profile);
    if (data.goals) await kvSet("goals", data.goals);
    if (data.settings) await kvSet("settings", data.settings);
    return { count: records.length, added: added };
  }

  // ---------------------------------------------------------------- 设置（LLM key 等）

  async function getSettings() {
    return (await kvGet("settings", {})) || {};
  }
  async function setSettings(settings) {
    await kvSet("settings", settings || {});
  }

  window.FitDB = {
    RECORD_TYPES: RECORD_TYPES,
    addRecords: addRecords,
    updateRecord: updateRecord,
    listRecords: listRecords,
    softDelete: softDelete,
    restore: restore,
    listDeleted: listDeleted,
    latestWeight: latestWeight,
    getProfile: getProfile,
    updateProfile: updateProfile,
    getGoals: getGoals,
    updateGoals: updateGoals,
    dailySummary: dailySummary,
    rangeStats: rangeStats,
    exportAll: exportAll,
    importAll: importAll,
    getDeviceId: getDeviceId,
    getSettings: getSettings,
    setSettings: setSettings,
  };
})();
