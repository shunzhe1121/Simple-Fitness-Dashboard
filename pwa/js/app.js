/* 健身记录助手 —— 前端逻辑（Vue 3 + Chart.js，零构建）。
 *
 * PWA 本地版：数据全部走浏览器内 IndexedDB（FitDB / FitLocalApi），
 * 无后端服务。AI 对话由 FitAgent 浏览器直连 OpenAI 兼容接口。
 */
(function () {
  "use strict";

  // 图表实例放在模块级，避免被 Vue 响应式包裹导致 Chart.js 内部异常
  const charts = {};

  // Chart.js 全局默认值：统一字体、动画、元素与 tooltip 视觉
  function applyChartDefaults() {
    if (!window.Chart) return;
    const C = window.Chart;
    const fontFamily =
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';
    C.defaults.font.family = fontFamily;
    C.defaults.font.size = 12;
    C.defaults.font.weight = "500";
    C.defaults.color = "#475569";
    C.defaults.animation = { duration: 700, easing: "easeOutQuart" };
    C.defaults.animations.colors = false;
    C.defaults.animations.x = false;
    C.defaults.elements.line.borderWidth = 2.5;
    C.defaults.elements.line.tension = 0.35;
    C.defaults.elements.line.fill = true;
    C.defaults.elements.point.radius = 3;
    C.defaults.elements.point.hoverRadius = 5;
    C.defaults.elements.point.borderWidth = 0;
    C.defaults.elements.bar.borderRadius = 8;
    C.defaults.elements.bar.borderSkipped = false;
    C.defaults.elements.bar.maxBarThickness = 36;
  }

  const NAV_ITEMS = [
    { key: "today", label: "今日总览", color: "#2f6df6" },
    { key: "diet", label: "饮食记录", color: "#f59e0b" },
    { key: "workout", label: "训练记录", color: "#ef4444" },
    { key: "body", label: "身体数据", color: "#10b981" },
    { key: "stats", label: "统计分析", color: "#8b5cf6" },
    { key: "settings", label: "设置", color: "#6b7280" },
  ];

  const MEALS = ["早餐", "午餐", "晚餐", "加餐"];
  const CATEGORIES = ["有氧", "胸", "背", "腿", "肩", "手臂", "核心", "全身"];

  const SAMPLES = [
    "今天练胸40分钟消耗300卡",
    "我今天体重73kg",
    "分析一下这一周的饮食",
    "把今天的午餐记下来：米饭一碗、鸡胸肉一块",
    "删除今天的第一条饮食记录",
  ];

  // 热量缺口分级参考表（用于「?」弹窗）。缺口 = 有效目标 − 净摄入(饮食−运动消耗)。
  // 每 7700 kcal 缺口约对应 1kg 脂肪：每天 500 kcal 缺口 ≈ 每周减 0.5kg，属推荐的中等强度。
  const DEFICIT_REF = [
    { range: "≥1000", label: "极速减脂", tone: "danger", desc: "每天缺口≥1000kcal，每周可能掉1kg以上，易掉肌肉、代谢下降、反弹，一般不建议" },
    { range: "750–1000", label: "高强度减脂", tone: "warn", desc: "每天缺口750–1000kcal，每周约减0.7–0.9kg，适合有经验者短期冲刺，需盯紧蛋白质与营养" },
    { range: "500–750", label: "中度减脂", tone: "ok", desc: "每天缺口500–750kcal，每周约减0.5–0.7kg，强度与可持续性平衡，多数人推荐区间" },
    { range: "200–500", label: "轻度减脂", tone: "ok", desc: "每天缺口200–500kcal，每周约减0.2–0.5kg，最温和、最容易长期坚持" },
    { range: "±200", label: "基本持平", tone: "neutral", desc: "缺口在±200kcal内，摄入接近消耗，体重基本稳定" },
    { range: "≤−200", label: "热量盈余", tone: "warn", desc: "摄入高于消耗≥200kcal，体重易上升；增肌期可用、减脂期应避免" },
  ];
  const TONE_COLOR = { danger: "#ef4444", warn: "#f59e0b", ok: "#10b981", neutral: "#6b7280" };

  const EMPTY_SUMMARY = {
    diet: { total: { calories: 0, protein: 0, fat: 0, carbs: 0, count: 0 }, records: [] },
    workout: { total: { duration_min: 0, calories: 0, count: 0 }, records: [] },
    body: null,
    goals: {},
  };

  const { createApp } = Vue;

  applyChartDefaults();

  createApp({
    data() {
      return {
        // 导航与布局
        view: "today",
        navOpen: false,
        chatOpen: false,
        theme: "auto",

        // 日期
        selectedDate: "",
        // 页面加载当天（跨天检测用：停留在加载日时自动跳到新的一天）
        loadDate: "",

        // 元信息与全局状态
        meta: { record_types: {}, options: {}, llm: {}, today: "" },
        llmReady: false,
        profile: {},
        goals: {},
        summary: JSON.parse(JSON.stringify(EMPTY_SUMMARY)),
        statsData: null,
        bodySeries: null,

        // 记录
        records: { diet: [], workout: [] },
        bodyHistory: [],
        editing: null, // { type, id, draft } — 行内编辑状态

        // 表单
        bodyRangeDays: 30,
        statsDays: 7,
        dietForm: { meal_type: "午餐", food_name: "", amount: "", calories: "", protein: "", fat: "", carbs: "" },
        workoutForm: { category: "有氧", duration_min: "", calories: "", note: "" },
        bodyForm: { weight: "", body_fat: "", waist: "" },

        // 模板粘贴
        pasteText: "",
        parsePreview: null,

        // 回收站
        trash: {},
        trashLoaded: false,

        // 对话
        chatMessages: [],
        chatInput: "",
        chatBusy: false,
        pending: [],

        // 杂项
        toast: null,
        busy: false,
        planExplain: "",
        showDeficitInfo: false,
        showGoalInfo: false,
        // 这两个表单对象必须在 data() 里初始化，否则首次进入设置页时
        // v-model 绑到 undefined 会让 Vue 抛错、整页黑屏
        profileForm: { height: "", birth_year: "", gender: "male", activity_level: "moderate", goal_type: "maintain" },
        goalsForm: { daily_calories: "", protein_g: "", fat_g: "", carbs_g: "", target_weight: "", workout_days_per_week: "" },
        llmForm: { api_key: "", base_url: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },

        // 下拉与示例常量
        navItems: NAV_ITEMS,
        meals: MEALS,
        categories: CATEGORIES,
        samples: SAMPLES,
        deficitRef: DEFICIT_REF,
      };
    },

    computed: {
      currentNav() {
        return this.navItems.find((n) => n.key === this.view) || this.navItems[0];
      },
      themeLabel() {
        return this.theme === "auto" ? "跟随系统" : this.theme === "light" ? "浅色" : "深色";
      },
      goalCalories() {
        return this.goals && this.goals.daily_calories ? this.goals.daily_calories : null;
      },
      // 有效目标 = 基础目标 + 当日训练消耗。训练烧掉的热量算进当天预算，
      // 环、状态提示、净摄入对比都用它，避免「练了 250 千卡却被判超出目标」。
      effectiveGoal() {
        const base = this.goalCalories;
        if (!base) return null;
        const workout = (this.summary.workout.total.calories || 0);
        return Math.round(base + workout);
      },
      workoutBonus() {
        const w = this.summary.workout.total.calories || 0;
        return w > 0 ? Math.round(w) : 0;
      },
      netCalories() {
        const s = this.summary;
        return Math.round((s.diet.total.calories || 0) - (s.workout.total.calories || 0));
      },
      calorieState() {
        const s = this.summary;
        const intake = s.diet.total.calories || 0;
        const goal = this.effectiveGoal;
        if (!goal) return { text: "未设目标", tone: "muted" };
        const diff = intake - goal;
        if (diff > goal * 0.1) return { text: `超出目标 ${Math.round(diff)} kcal`, tone: "over" };
        if (diff < -goal * 0.1) return { text: `低于目标 ${Math.round(-diff)} kcal`, tone: "under" };
        return { text: `接近目标（差 ${Math.round(diff)} kcal）`, tone: "ok" };
      },
      ringStyle() {
        const goal = this.effectiveGoal;
        const intake = this.summary.diet.total.calories || 0;
        const r = 52;
        const circ = 2 * Math.PI * r; // ≈326.7
        const pct = goal ? Math.min(intake / goal, 1) : 0;
        return {
          strokeDasharray: circ,
          strokeDashoffset: circ * (1 - pct),
        };
      },
      macroBars() {
        const s = this.summary;
        const t = s.diet.total;
        const g = this.goals || {};
        const defs = [
          { key: "protein", label: "蛋白质", value: t.protein, goal: g.protein_g, color: "#3b82f6" },
          { key: "fat", label: "脂肪", value: t.fat, goal: g.fat_g, color: "#f59e0b" },
          { key: "carbs", label: "碳水", value: t.carbs, goal: g.carbs_g, color: "#10b981" },
        ];
        return defs.map((d) => {
          const v = d.value || 0;
          const pct = d.goal ? Math.min(Math.round((v / d.goal) * 100), 100) : 0;
          return Object.assign({}, d, { value: v, percent: pct });
        });
      },
      dietGroups() {
        const s = this.summary;
        if (!s || !s.diet.records) return [];
        const map = {};
        s.diet.records.forEach((r) => {
          const k = r.meal_type || "其他";
          (map[k] = map[k] || []).push(r);
        });
        return Object.keys(map).map((name) => {
          const rows = map[name];
          const calories = rows.reduce((a, r) => a + (r.calories || 0), 0);
          return { name, rows, calories };
        });
      },
      previewGroups() {
        if (!this.parsePreview) return {};
        const out = {};
        for (const type of ["diet", "workout", "body"]) {
          if (this.parsePreview[type] && this.parsePreview[type].length) out[type] = this.parsePreview[type];
        }
        return out;
      },
      kpis() {
        const s = this.statsData;
        if (!s) return [];
        const a = s.averages || {};
        const t = s.totals || {};
        return [
          { label: "日均摄入", value: this.fmt(a.diet_calories, 0), unit: "kcal" },
          { label: "日均训练消耗", value: this.fmt(a.workout_calories, 0), unit: "kcal" },
          { label: "训练天数", value: this.fmt(t.workout_days, 0), unit: "d" },
          { label: "平均体重", value: this.fmt(a.weight, 1), unit: "kg" },
          { label: "饮食条数", value: this.fmt(t.diet_records, 0), unit: "" },
          {
            label: "目标差距",
            value: s.goal_gap == null ? "—" : (s.goal_gap >= 0 ? "+" : "") + this.fmt(s.goal_gap, 0),
            unit: "kcal",
          },
        ];
      },
      profileComplete() {
        const p = this.profile || {};
        return !!(p.height && p.age && p.gender && p.latest_weight);
      },
      needOnboarding() {
        // 档案不全（身高/体重/年龄/性别任一缺失）就需要建档引导
        return !this.profileComplete;
      },
      deficit() {
        return this.summary.deficit;
      },
      deficitBand() {
        return this.summary.deficit_band;
      },
      deficitDisplay() {
        // 统一用有效目标口径，与热量环一致：缺口 = 有效目标 − 饮食摄入
        const goal = this.effectiveGoal;
        const intake = this.summary.diet.total.calories || 0;
        if (goal == null) return "—";
        const d = goal - intake;
        return (d >= 0 ? "缺口 " : "盈余 ") + this.fmt(Math.abs(d), 0) + " kcal";
      },
      deficitColor() {
        const band = this.summary.deficit_band;
        return (band && TONE_COLOR[band.tone]) || "#6b7280";
      },
    },

    mounted() {
      this.theme = localStorage.getItem("fit-theme") || "auto";
      this.applyTheme();
      this.bootstrap();
      // ESC 关闭浮窗
      window.addEventListener("keydown", this.onKeyDown);
      // 跨天检测：bfcache 恢复 / 切回前台时，若页面还停留在加载当天则自动跳到新的一天
      window.addEventListener("pageshow", this.onPageShow);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    },
    beforeUnmount() {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("pageshow", this.onPageShow);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    },

    methods: {
      onKeyDown(e) {
        if (e.key === "Escape" && this.chatOpen) this.chatOpen = false;
      },
      // 页面从 bfcache 恢复（前进/后退/重开标签）时触发，persisted=true 表示页面未重新加载
      onPageShow(e) {
        if (e.persisted) this.syncDateIfCrossDay();
      },
      onVisibilityChange() {
        if (document.visibilityState === "visible") this.syncDateIfCrossDay();
      },
      // 跨天检测：若用户仍停留在「页面加载当天」且今天已变化，自动跳到今天。
      // 用户手动选过历史日期（selectedDate !== loadDate）时不动，避免打断补录。
      async syncDateIfCrossDay() {
        if (!this.loadDate) return;
        try {
          const meta = await this.api("/api/meta");
          const today = meta.today || "";
          if (!today || today === this.loadDate) return;
          if (this.selectedDate !== this.loadDate) return;
          this.selectedDate = today;
          this.loadDate = today;
          await this.refreshData();
        } catch (e) {
          /* 网络抖动静默，下次可见时再试 */
        }
      },
      // ---------------------------------------------------------- 基础请求
      // PWA 本地版：/api/* 全部由 FitLocalApi 分发到 IndexedDB / 营养 / 解析 / Agent
      async api(path, body, method) {
        return FitLocalApi.handle(path, body, method);
      },

      num(v) {
        if (v === "" || v === null || v === undefined) return null;
        const n = Number(v);
        return isNaN(n) ? null : n;
      },
      int(v) {
        if (v === "" || v === null || v === undefined) return null;
        const n = parseInt(v, 10);
        return isNaN(n) ? null : n;
      },
      fmt(v, d) {
        if (v === null || v === undefined || v === "" || (typeof v === "number" && isNaN(v))) {
          return d === 0 ? "0" : "—";
        }
        const n = Number(v);
        if (isNaN(n)) return "—";
        return n.toFixed(d === undefined ? 1 : d);
      },
      sumOf(rows, field) {
        return (rows || []).reduce((a, r) => a + (Number(r[field]) || 0), 0);
      },
      toneColor(tone) {
        return TONE_COLOR[tone] || "#6b7280";
      },
      startOnboarding() {
        this.chatInput = "帮我建立健康档案";
        this.sendChat();
      },

      notify(opts) {
        this.toast = { text: opts.text, tone: opts.tone || "ok" };
        if (this._toastTimer) clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
          this.toast = null;
        }, 2600);
      },

      // ---------------------------------------------------------- 启动引导
      async bootstrap() {
        try {
          this.meta = await this.api("/api/meta");
          this.llmReady = !!(this.meta.llm && this.meta.llm.configured);
          this.selectedDate = this.meta.today || "";
          this.loadDate = this.selectedDate;
        } catch (e) {
          this.notify({ text: "加载元信息失败：" + e.message, tone: "error" });
        }
        try {
          this.profile = await this.api("/api/profile");
          this.goals = await this.api("/api/goals");
        } catch (e) {
          /* 容错，进入页面后再补 */
        }
        try {
          const hist = await this.api("/api/agent/history");
          this.chatMessages = (hist.messages || []).map((m) => ({ role: m.role, content: m.content }));
        } catch (e) {
          /* 忽略 */
        }
        try {
          const pend = await this.api("/api/pending");
          this.pending = (pend.pending || []).map((p) => ({ id: p.id, summary: p.summary || "", records: [] }));
        } catch (e) {
          /* 忽略 */
        }
        this.go(this.view);
      },

      // ---------------------------------------------------------- 导航与主题
      go(key) {
        this.view = key;
        this.navOpen = false;
        this.onEnterView(key);
      },
      onEnterView(key) {
        if (key === "today") this.loadToday();
        else if (key === "diet") this.loadRecords("diet");
        else if (key === "workout") this.loadRecords("workout");
        else if (key === "body") {
          this.loadBodyHistory();
          this.loadBodyTrend();
        } else if (key === "stats") this.loadStats();
        else if (key === "settings") this.loadSettings();
      },
      onDateChange() {
        if (this.view === "today") this.loadToday();
        else if (this.view === "diet") this.loadRecords("diet");
        else if (this.view === "workout") this.loadRecords("workout");
        else if (this.view === "body") {
          this.loadBodyHistory();
          this.loadBodyTrend();
        }
      },
      applyTheme() {
        const html = document.documentElement;
        if (this.theme === "light") html.setAttribute("data-theme", "light");
        else if (this.theme === "dark") html.setAttribute("data-theme", "dark");
        else html.removeAttribute("data-theme"); // auto → rely on @media query
      },
      cycleTheme() {
        const order = ["auto", "light", "dark"];
        this.theme = order[(order.indexOf(this.theme) + 1) % order.length];
        localStorage.setItem("fit-theme", this.theme);
        this.$nextTick(() => {
          if (this.view === "stats") this.renderStatsCharts();
          else if (this.view === "body") this.renderBodyChart();
        });
      },
      isDark() {
        if (this.theme === "dark") return true;
        if (this.theme === "light") return false;
        return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      },

      // ---------------------------------------------------------- 数据加载
      async refreshData() {
        try {
          this.profile = await this.api("/api/profile");
          this.goals = await this.api("/api/goals");
          if (this.view === "today") await this.loadToday();
          if (this.view === "diet") await this.loadRecords("diet");
          if (this.view === "workout") await this.loadRecords("workout");
          if (this.view === "body") {
            await this.loadBodyHistory();
            await this.loadBodyTrend();
          }
          if (this.view === "stats") await this.loadStats();
        } catch (e) {
          /* 静默，单条刷新失败不影响整体 */
        }
      },
      async loadToday() {
        this.summary = await this.api("/api/summary/daily?date=" + this.selectedDate);
      },
      async loadRecords(type) {
        const res = await this.api("/api/records/" + type + "?date=" + this.selectedDate);
        this.records[type] = res.records || [];
      },
      async loadBodyHistory() {
        const res = await this.api("/api/records/body?limit=200");
        this.bodyHistory = res.records || [];
      },
      async loadBodyTrend() {
        const res = await this.api("/api/stats/range?days=" + this.bodyRangeDays);
        this.bodySeries = { days: res.series.days, weight: res.series.weight };
        await this.$nextTick();
        this.renderBodyChart();
      },
      async loadStats() {
        const res = await this.api("/api/stats/range?days=" + this.statsDays);
        this.statsData = res;
        await this.$nextTick();
        this.renderStatsCharts();
      },
      async loadSettings() {
        this.profile = await this.api("/api/profile");
        const p = this.profile;
        this.profileForm = {
          height: p.height ?? "",
          birth_year: p.birth_year ?? "",
          gender: p.gender || "male",
          activity_level: p.activity_level || "moderate",
          goal_type: p.goal_type || "maintain",
        };
        this.goals = await this.api("/api/goals");
        const g = this.goals;
        this.goalsForm = {
          daily_calories: g.daily_calories ?? "",
          protein_g: g.protein_g ?? "",
          fat_g: g.fat_g ?? "",
          carbs_g: g.carbs_g ?? "",
          target_weight: g.target_weight ?? "",
          workout_days_per_week: g.workout_days_per_week ?? "",
        };
        // LLM 配置（PWA 本地版：key 存手机本地）
        const s = await FitDB.getSettings();
        this.llmForm = {
          api_key: s.llm_api_key || "",
          base_url: s.llm_base_url || "https://api.siliconflow.cn/v1",
          model: s.llm_model || "deepseek-ai/DeepSeek-V3",
        };
      },
      async saveLlm() {
        try {
          await FitDB.setSettings({
            llm_api_key: (this.llmForm.api_key || "").trim(),
            llm_base_url: (this.llmForm.base_url || "").trim(),
            llm_model: (this.llmForm.model || "").trim(),
          });
          this.llmReady = !!(this.llmForm.api_key || "").trim();
          this.notify({ text: "AI 配置已保存（key 仅存本机）", tone: "ok" });
        } catch (e) {
          this.notify({ text: "保存失败：" + e.message, tone: "error" });
        }
      },

      // ---------------------------------------------------------- 记录增删改
      startEdit(type, row) {
        // 深拷贝，避免编辑中直接改动原行数据
        this.editing = { type, id: row.id, draft: { ...row } };
      },
      isEditing(type, id) {
        return !!(this.editing && this.editing.type === type && this.editing.id === id);
      },
      cancelEdit() {
        this.editing = null;
      },
      async saveEdit(type) {
        const edit = this.editing;
        if (!edit) return;
        this.busy = true;
        try {
          // 数字字段转数字，去掉只读字段
          const draft = { ...edit.draft };
          delete draft.id;
          const numFields =
            type === "diet"
              ? ["calories", "protein", "fat", "carbs"]
              : type === "workout"
                ? ["duration_min", "calories"]
                : ["weight", "body_fat", "waist"];
          numFields.forEach((k) => { draft[k] = this.num(draft[k]); });
          if (type === "diet") {
            draft.amount = draft.amount || null;
            draft.meal_type = draft.meal_type || null;
          }
          if (type === "workout") draft.note = draft.note || null;

          await this.api("/api/records/" + type + "/" + edit.id, draft, "PUT");
          this.editing = null;
          await this.refreshData();
          this.notify({ text: "已保存修改", tone: "ok" });
        } catch (e) {
          this.notify({ text: "保存失败：" + e.message, tone: "error" });
        } finally {
          this.busy = false;
        }
      },
      async removeRecord(type, row) {
        try {
          await this.api("/api/records/" + type + "/" + row.id, null, "DELETE");
          if (type === "body") {
            this.bodyHistory = this.bodyHistory.filter((r) => r.id !== row.id);
            this.loadBodyTrend();
          } else {
            this.records[type] = this.records[type].filter((r) => r.id !== row.id);
          }
          if (this.view === "today") this.loadToday();
          this.notify({ text: "已删除", tone: "ok" });
        } catch (e) {
          this.notify({ text: "删除失败：" + e.message, tone: "error" });
        }
      },
      async submitForm(type) {
        this.busy = true;
        try {
          if (type === "diet") {
            const f = this.dietForm;
            const payload = {
              meal_type: f.meal_type,
              food_name: f.food_name,
              amount: f.amount || null,
              calories: this.num(f.calories),
              protein: this.num(f.protein),
              fat: this.num(f.fat),
              carbs: this.num(f.carbs),
            };
            await this.api("/api/records/diet", payload, "POST");
            this.dietForm = { meal_type: "午餐", food_name: "", amount: "", calories: "", protein: "", fat: "", carbs: "" };
            this.notify({ text: "已添加饮食", tone: "ok" });
          } else if (type === "workout") {
            const f = this.workoutForm;
            const payload = {
              category: f.category,
              duration_min: this.num(f.duration_min),
              calories: this.num(f.calories),
              note: f.note || null,
            };
            await this.api("/api/records/workout", payload, "POST");
            this.workoutForm = { category: "有氧", duration_min: "", calories: "", note: "" };
            this.notify({ text: "已添加训练", tone: "ok" });
          } else if (type === "body") {
            const f = this.bodyForm;
            const payload = { weight: this.num(f.weight), body_fat: this.num(f.body_fat), waist: this.num(f.waist) };
            await this.api("/api/records/body", payload, "POST");
            this.bodyForm = { weight: "", body_fat: "", waist: "" };
            this.notify({ text: "已记录身体数据", tone: "ok" });
          }
          await this.refreshData();
        } catch (e) {
          this.notify({ text: "添加失败：" + e.message, tone: "error" });
        } finally {
          this.busy = false;
        }
      },

      // ---------------------------------------------------------- 模板解析
      async previewPaste() {
        try {
          this.parsePreview = await this.api("/api/parse/preview", {
            text: this.pasteText,
            date: this.selectedDate,
          }, "POST");
        } catch (e) {
          this.notify({ text: "预览失败：" + e.message, tone: "error" });
        }
      },
      async importPaste() {
        this.busy = true;
        try {
          const res = await this.api(
            "/api/parse/import",
            { text: this.pasteText, date: this.selectedDate },
            "POST"
          );
          this.notify({ text: "已导入 " + res.count + " 条", tone: "ok" });
          this.pasteText = "";
          this.parsePreview = null;
          await this.refreshData();
        } catch (e) {
          this.notify({ text: "导入失败：" + e.message, tone: "error" });
        } finally {
          this.busy = false;
        }
      },
      describePreview(type, row) {
        if (type === "diet")
          return [row.meal_type, row.food_name, row.amount, row.calories != null ? row.calories + "kcal" : ""]
            .filter(Boolean)
            .join(" · ");
        if (type === "workout")
          return [row.category, row.duration_min != null ? row.duration_min + "min" : "", row.calories != null ? row.calories + "kcal" : ""]
            .filter(Boolean)
            .join(" · ");
        if (type === "body")
          return [
            row.weight != null ? "体重" + row.weight + "kg" : "",
            row.body_fat != null ? "体脂" + row.body_fat + "%" : "",
            row.waist != null ? "腰围" + row.waist + "cm" : "",
          ]
            .filter(Boolean)
            .join(" · ");
        return "";
      },
      copyPrompt() {
        const text = this.meta.doubao_prompt || "";
        const done = () => this.notify({ text: "已复制识图提示词", tone: "ok" });
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => this.fallbackCopy(text, done));
        } else {
          this.fallbackCopy(text, done);
        }
      },
      fallbackCopy(text, done) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          done();
        } catch (e) {
          this.notify({ text: "复制失败，请手动选择", tone: "error" });
        }
        document.body.removeChild(ta);
      },

      // ---------------------------------------------------------- 设置页
      async saveProfile() {
        this.busy = true;
        try {
          const f = this.profileForm;
          const payload = {
            height: this.num(f.height),
            birth_year: this.int(f.birth_year),
            gender: f.gender,
            activity_level: f.activity_level,
            goal_type: f.goal_type,
          };
          await this.api("/api/profile", payload, "PUT");
          this.profile = await this.api("/api/profile");
          this.notify({ text: "资料已保存", tone: "ok" });
        } catch (e) {
          this.notify({ text: "保存失败：" + e.message, tone: "error" });
        } finally {
          this.busy = false;
        }
      },
      async calcGoals() {
        this.busy = true;
        try {
          const f = this.profileForm;
          const payload = {
            weight: this.profile.latest_weight != null ? this.profile.latest_weight : null,
            height: this.num(f.height),
            age: this.profile.age != null ? this.profile.age : null,
            gender: f.gender,
            activity_level: f.activity_level,
            goal_type: f.goal_type,
            target_weight: this.num(this.goalsForm.target_weight),
            workout_days_per_week: this.int(this.goalsForm.workout_days_per_week),
          };
          const res = await this.api("/api/goals/calc", payload, "POST");
          this.goals = res.goals;
          const g = this.goals;
          this.goalsForm = {
            daily_calories: g.daily_calories ?? "",
            protein_g: g.protein_g ?? "",
            fat_g: g.fat_g ?? "",
            carbs_g: g.carbs_g ?? "",
            target_weight: g.target_weight ?? "",
            workout_days_per_week: g.workout_days_per_week ?? "",
          };
          this.planExplain = res.plan.explain;
          this.notify({ text: "已推算目标", tone: "ok" });
        } catch (e) {
          this.notify({ text: "推算失败：" + e.message, tone: "error" });
        } finally {
          this.busy = false;
        }
      },
      async exportData() {
        try {
          const data = await FitDB.exportAll();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "fit-backup-" + this.selectedDate + ".json";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
          this.notify({ text: "已导出备份文件（含全部记录）", tone: "ok" });
        } catch (e) {
          this.notify({ text: "导出失败：" + e.message, tone: "error" });
        }
      },
      async importData(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          const res = await this.api("/api/import", { data: data, replace: false }, "POST");
          const added = (res && res.added) || 0;
          const skipped = Math.max(((res && res.count) || 0) - added, 0);
          let msg = "导入完成";
          if (added > 0) msg = "已导入 " + added + " 条";
          if (skipped > 0) msg += added > 0 ? "，跳过重复 " + skipped + " 条" : "，没有新记录（" + skipped + " 条已存在）";
          this.notify({ text: msg + "，回到今日总览", tone: "ok" });
          await this.refreshData();
          // 导入完成后切到今日总览，让用户立刻看到效果（避免停留在 settings 页以为没刷新）
          this.go("today");
        } catch (e) {
          this.notify({ text: "导入失败：" + e.message, tone: "error" });
        } finally {
          event.target.value = "";
        }
      },
      async loadTrash() {
        this.trash = {};
        for (const type of ["diet", "workout", "body"]) {
          const res = await this.api("/api/records/" + type + "/trash?limit=100");
          if (res.records && res.records.length) this.trash[type] = res.records;
        }
        this.trashLoaded = true;
      },
      async restoreRecord(type, row) {
        try {
          await this.api("/api/records/" + type + "/" + row.id + "/restore", null, "POST");
          this.notify({ text: "已恢复", tone: "ok" });
          await this.loadTrash();
          await this.refreshData();
        } catch (e) {
          this.notify({ text: "恢复失败：" + e.message, tone: "error" });
        }
      },

      // ---------------------------------------------------------- 对话 / Agent
      async sendChat() {
        const text = (this.chatInput || "").trim();
        if (!text || this.chatBusy) return;
        this.chatMessages.push({ role: "user", content: text });
        this.chatInput = "";
        this.chatBusy = true;
        this.scrollChat();
        try {
          const res = await this.api("/api/agent/chat", { message: text }, "POST");
          this.chatMessages.push({ role: "assistant", content: res.reply });
          (res.pending || []).forEach((p) => this.addPending(p));
          (res.ui_actions || []).forEach((a) => this.applyUiAction(a));
          if (res.data_changed || (res.ui_actions && res.ui_actions.length)) {
            await this.refreshData();
          }
        } catch (e) {
          this.notify({ text: "对话失败：" + e.message, tone: "error" });
        } finally {
          this.chatBusy = false;
          this.$nextTick(() => this.scrollChat());
        }
      },
      addPending(p) {
        const item = {
          id: p.id != null ? p.id : p.pending_id,
          summary: p.summary || p.message || "",
          records: p.records || [],
        };
        if (this.pending.some((x) => x.id === item.id)) return;
        this.pending.push(item);
      },
      applyUiAction(a) {
        if (!a || a.type !== "navigate") return;
        if (a.date) this.selectedDate = a.date;
        if (a.view === "stats" && a.days) this.statsDays = a.days;
        this.go(a.view);
      },
      async confirmPending(id) {
        try {
          await this.api("/api/pending/" + id + "/confirm", {}, "POST");
          this.pending = this.pending.filter((p) => p.id !== id);
          this.notify({ text: "已删除所选记录", tone: "ok" });
          await this.refreshData();
        } catch (e) {
          this.notify({ text: "确认失败：" + e.message, tone: "error" });
        }
      },
      async cancelPending(id) {
        try {
          await this.api("/api/pending/" + id + "/cancel", {}, "POST");
        } catch (e) {
          /* 忽略 */
        }
        this.pending = this.pending.filter((p) => p.id !== id);
      },
      async clearChat() {
        try {
          await this.api("/api/agent/history", null, "DELETE");
        } catch (e) {
          /* 忽略 */
        }
        this.chatMessages = [];
        this.pending = [];
        this.notify({ text: "对话已清空", tone: "ok" });
      },
      scrollChat() {
        const el = this.$refs.chatBody;
        if (el) el.scrollTop = el.scrollHeight;
      },

      // ---------------------------------------------------------- 图表
      // 统一的图表外观基线：字体、配色、tooltip、图例、padding 由 applyChartDefaults
      // + baseOptions() 一并决定。实例只填数据。
      baseOptions(kind) {
        const dark = this.isDark();
        const grid = dark ? "rgba(148,163,184,.18)" : "rgba(15,23,42,.06)";
        const tick = dark ? "#cbd5e1" : "#64748b";
        const legendLabel = dark ? "#e2e8f0" : "#334155";

        // 玻璃感 tooltip：跟随主题给一组 alpha 适配
        const tooltipBg = dark ? "rgba(15,23,42,.92)" : "rgba(15,23,42,.88)";
        const tooltipText = "#f8fafc";
        const tooltipTitle = "#cbd5e1";

        const legend = {
          position: "bottom",
          align: "start",
          labels: {
            color: legendLabel,
            boxWidth: 10,
            boxHeight: 10,
            padding: 14,
            usePointStyle: true,
            pointStyle: "circle",
            font: { size: 12, weight: "500" },
          },
        };

        const scales = {
          x: {
            grid: { color: grid, drawTicks: false },
            border: { display: false },
            ticks: { color: tick, padding: 8, maxTicksLimit: 10, font: { size: 11 } },
          },
          y: {
            grid: { color: grid, drawTicks: false },
            border: { display: false },
            beginAtZero: true,
            grace: "8%",
            ticks: { color: tick, padding: 8, font: { size: 11 } },
          },
        };

        const tooltip = {
          backgroundColor: tooltipBg,
          titleColor: tooltipTitle,
          bodyColor: tooltipText,
          borderColor: "transparent",
          borderWidth: 0,
          padding: { x: 12, y: 10 },
          cornerRadius: 10,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
          titleFont: { size: 12, weight: "600" },
          bodyFont: { size: 12, weight: "500" },
          caretSize: 6,
          caretPadding: 8,
        };

        const options = {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          layout: { padding: { top: 6, bottom: 4, left: 4, right: 8 } },
          plugins: { legend, tooltip },
        };

        if (kind === "line" || kind === "bar") {
          options.scales = scales;
        }
        if (kind === "bar") {
          // 柱状图：去掉水平网格，只保留 X 轴 0 线，更干净
          options.scales.x.grid = { display: false };
          options.scales.y.grid = { color: grid, drawTicks: false };
        }
        if (kind === "doughnut") {
          options.cutout = "62%";
          options.radius = "92%";
          options.spacing = 2;
        }
        return options;
      },
      renderChart(refName, config) {
        if (!window.Chart) return;
        const canvas = this.$refs[refName];
        if (!canvas) return;
        if (charts[refName]) charts[refName].destroy();
        charts[refName] = new Chart(canvas.getContext("2d"), config);
      },
      renderBodyChart() {
        if (!this.bodySeries) return;
        const canvas = this.$refs.bodyChart;
        const ctx = canvas ? canvas.getContext("2d") : null;
        const grad = ctx
          ? ctx.createLinearGradient(0, 0, 0, canvas.height || 280)
          : null;
        if (grad) {
          grad.addColorStop(0, "rgba(16,185,129,.35)");
          grad.addColorStop(1, "rgba(16,185,129,0)");
        }
        this.renderChart("bodyChart", {
          type: "line",
          data: {
            labels: this.bodySeries.days,
            datasets: [
              {
                label: "体重 kg",
                data: this.bodySeries.weight,
                borderColor: "#10b981",
                backgroundColor: grad || "rgba(16,185,129,.18)",
                pointBackgroundColor: "#10b981",
                spanGaps: true,
                fill: true,
              },
            ],
          },
          options: this.baseOptions("line"),
        });
      },
      renderStatsCharts() {
        const s = this.statsData;
        if (!s) return;
        const days = s.series.days;

        // 摄入 / 消耗两条线
        const cCalCanvas = this.$refs.calorieChart;
        const cCalCtx = cCalCanvas ? cCalCanvas.getContext("2d") : null;
        const intakeGrad = cCalCtx
          ? cCalCtx.createLinearGradient(0, 0, 0, cCalCanvas.height || 280)
          : null;
        if (intakeGrad) {
          intakeGrad.addColorStop(0, "rgba(245,158,11,.32)");
          intakeGrad.addColorStop(1, "rgba(245,158,11,0)");
        }
        const burnGrad = cCalCtx
          ? cCalCtx.createLinearGradient(0, 0, 0, cCalCanvas.height || 280)
          : null;
        if (burnGrad) {
          burnGrad.addColorStop(0, "rgba(239,68,68,.28)");
          burnGrad.addColorStop(1, "rgba(239,68,68,0)");
        }
        this.renderChart("calorieChart", {
          type: "line",
          data: {
            labels: days,
            datasets: [
              {
                label: "摄入",
                data: s.series.diet_calories,
                borderColor: "#f59e0b",
                backgroundColor: intakeGrad || "rgba(245,158,11,.18)",
                pointBackgroundColor: "#f59e0b",
                fill: true,
              },
              {
                label: "训练消耗",
                data: s.series.workout_calories,
                borderColor: "#ef4444",
                backgroundColor: burnGrad || "rgba(239,68,68,.18)",
                pointBackgroundColor: "#ef4444",
                fill: true,
              },
            ],
          },
          options: this.baseOptions("line"),
        });

        // 宏量占比
        const ms = s.macro_share || {};
        const macroTotal = (ms.protein_share || 0) + (ms.fat_share || 0) + (ms.carbs_share || 0);
        if (macroTotal > 0) {
          this.renderChart("macroChart", {
            type: "doughnut",
            data: {
              labels: ["蛋白质", "脂肪", "碳水"],
              datasets: [
                {
                  data: [ms.protein_share || 0, ms.fat_share || 0, ms.carbs_share || 0],
                  backgroundColor: ["#3b82f6", "#f59e0b", "#10b981"],
                  borderColor: this.isDark() ? "#1e293b" : "#ffffff",
                  borderWidth: 2,
                  hoverOffset: 8,
                },
              ],
            },
            options: this.baseOptions("doughnut"),
          });
        } else {
          this.clearChart("macroChart");
        }

        // 训练部位分布
        const cat = s.category_minutes || {};
        const catLabels = Object.keys(cat);
        const catValues = Object.values(cat);
        if (catLabels.length) {
          const palette = ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#6366f1"];
          this.renderChart("categoryChart", {
            type: "bar",
            data: {
              labels: catLabels,
              datasets: [
                {
                  label: "min",
                  data: catValues,
                  backgroundColor: catLabels.map((_, i) => palette[i % palette.length]),
                  hoverBackgroundColor: catLabels.map((_, i) => palette[i % palette.length]),
                },
              ],
            },
            options: { ...this.baseOptions("bar"), plugins: { ...this.baseOptions("bar").plugins, legend: { display: false } } },
          });
        } else {
          this.clearChart("categoryChart");
        }

        // 体重曲线
        const wCanvas = this.$refs.weightChart;
        const wCtx = wCanvas ? wCanvas.getContext("2d") : null;
        const wGrad = wCtx
          ? wCtx.createLinearGradient(0, 0, 0, wCanvas.height || 280)
          : null;
        if (wGrad) {
          wGrad.addColorStop(0, "rgba(16,185,129,.3)");
          wGrad.addColorStop(1, "rgba(16,185,129,0)");
        }
        this.renderChart("weightChart", {
          type: "line",
          data: {
            labels: days,
            datasets: [
              {
                label: "体重 kg",
                data: s.series.weight,
                borderColor: "#10b981",
                backgroundColor: wGrad || "rgba(16,185,129,.18)",
                pointBackgroundColor: "#10b981",
                spanGaps: true,
                fill: true,
              },
            ],
          },
          options: this.baseOptions("line"),
        });
      },
      clearChart(refName) {
        if (charts[refName]) {
          charts[refName].destroy();
          delete charts[refName];
        }
        const canvas = this.$refs[refName];
        if (canvas) {
          const ctx = canvas.getContext("2d");
          ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      },
    },
    watch: {
      // 注意：这里只有一个 watch 对象。若再写一个 watch: {...} 会把本对象整体覆盖，
      // 导致 theme 变化时 applyTheme 永远不会被调用（曾因此主题切换无效）。
      theme() { this.applyTheme(); },
      chatMessages() {
        this.$nextTick(() => this.scrollChat());
      },
      pending() {
        this.$nextTick(() => this.scrollChat());
      },
    },
  }).mount("#app");
})();
