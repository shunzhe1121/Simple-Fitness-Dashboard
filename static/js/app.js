/* 健身记录助手 —— 前端逻辑（Vue 3 + Chart.js，零构建）。
 *
 * 网页只是 API 的一个客户端：所有数据读写、解析、Agent 对话都走 /api。
 * 以后做原生 App 或套壳时，直接复用同一批接口即可。
 */
(function () {
  "use strict";

  // 图表实例放在模块级，避免被 Vue 响应式包裹导致 Chart.js 内部异常
  const charts = {};

  // 图表配色统一从 CSS 变量读，改主题只要改 style.css 一处
  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  // canvas 渐变只认 rgba，CSS 变量是 hex —— 这里把 hex 拆成带透明度的 rgba
  function alpha(hex, a) {
    const h = String(hex || "").replace("#", "").trim();
    if (h.length !== 6) return hex;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return hex;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  // Chart.js 全局默认值：统一字体、动画、元素与 tooltip 视觉

  function applyChartDefaults() {
    if (!window.Chart) return;
    const C = window.Chart;
    const fontFamily =
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';
    C.defaults.font.family = fontFamily;
    C.defaults.font.size = 11;
    C.defaults.font.weight = "500";
    C.defaults.color = cssVar("--chart-tick", "#7d848e");
    C.defaults.animation = { duration: 800, easing: "easeOutQuart" };
    C.defaults.animations.colors = false;
    C.defaults.animations.x = false;
    C.defaults.elements.line.borderWidth = 1.6;
    C.defaults.elements.line.tension = 0.32;
    C.defaults.elements.line.fill = true;
    C.defaults.elements.line.cubicInterpolationMode = "monotone";
    C.defaults.elements.point.radius = 0;
    C.defaults.elements.point.hoverRadius = 4;
    C.defaults.elements.point.hitRadius = 14;
    C.defaults.elements.point.borderWidth = 2;
    C.defaults.elements.bar.borderRadius = 0;
    C.defaults.elements.bar.borderSkipped = false;
    C.defaults.elements.bar.maxBarThickness = 18;
  }

  const NAV_ITEMS = [
    { key: "today", label: "今日总览", color: "#2f6df6" },
    { key: "diet", label: "饮食记录", color: "#f59e0b" },
    { key: "workout", label: "训练记录", color: "#ef4444" },
    { key: "body", label: "身体数据", color: "#10b981" },
    { key: "stats", label: "统计分析", color: "#8b5cf6" },
    { key: "reports", label: "AI 日报", color: "#06b6d4" },
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
    target_calories: null,
    tdee: null,
    deficit_band: null,
  };

  const { createApp } = Vue;

  applyChartDefaults();

  const app = createApp({
    data() {
      return {
        // 导航与布局
        view: "today",
        navOpen: false,
        chatOpen: false,
        // 默认浅色：纸感底 + 信号橙是这个界面的本色，暗色是需要主动选择的分支
        theme: "light",

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

        // 饮食录入方式：图片分析 / 粘贴文本 / 手动添加
        dietEntry: "image",
        dietTabs: [
          { key: "image", label: "图片分析" },
          { key: "paste", label: "粘贴文本结果" },
          { key: "manual", label: "手动添加" },
        ],
        mealImages: [],
        mealUploading: false,
        mealAnalyzing: false,
        mealDrag: false,
        mealPreview: null,
        mealErrors: [],

        // 回收站
        trash: {},
        trashLoaded: false,

        // 对话
        chatMessages: [],
        chatInput: "",
        chatBusy: false,
        pending: [],

        // AI 日报与佳明
        reportsList: [],
        reportCurrent: null,
        reportBusy: false,
        garminStatus: null,
        garminBusy: false,

        // 杂项
        toast: null,
        busy: false,
        planExplain: "",
        showDeficitInfo: false,
        showGoalInfo: false,

        // 动效与音效：真值存在 localStorage，这里只是给界面读的镜像
        soundOn: true,
        soundVol: 55,
        motion: "auto",
        // 这两个表单对象必须在 data() 里初始化，否则首次进入设置页时
        // v-model 绑到 undefined 会让 Vue 抛错、整页黑屏
        profileForm: { height: "", birth_year: "", gender: "male", activity_level: "moderate", goal_type: "maintain" },
        goalsForm: { daily_calories: "", protein_g: "", fat_g: "", carbs_g: "", target_weight: "", workout_days_per_week: "" },

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
      motionLabel() {
        if (this.motion === "reduced") return "强制关闭";
        if (this.motion === "full") return "强制开启";
        return window.FX && FX.motionOff() ? "跟随系统（系统要求减少）" : "跟随系统";
      },
      goalCalories() {
        return this.goals && this.goals.daily_calories ? this.goals.daily_calories : null;
      },
      // 有效目标：后端已按「最近一次手表实测消耗」动态调整（有佳明数据时优先），
      // 无手表数据时回退 基础目标 + 当日训练消耗 的公式口径。
      effectiveGoal() {
        const backend = this.summary.target_calories;
        if (backend) return Math.round(backend);
        const base = this.goalCalories;
        if (!base) return null;
        const workout = (this.summary.workout.total.calories || 0);
        return Math.round(base + workout);
      },
      // 目标还差多少（负值表示已经吃超）
      remainingCalories() {
        const goal = this.effectiveGoal;
        if (!goal) return null;
        return Math.round(goal - (this.summary.diet.total.calories || 0));
      },
      // 手表实测总消耗：今天的还没同步完，取最近一次完整实测值
      measuredBurn() {
        return this.summary.tdee_measured || null;
      },
      // 实测值是否来自昨天等历史日期（今天的总消耗要等一天过完才完整）
      measuredFromPast() {
        return !!this.measuredBurn && !this.summary.is_measured_today;
      },
      // 当天实时消耗：手表同步过就用实测，否则按「静息 + 已走步数」估算
      todayBurn() {
        return this.summary.today_burn || null;
      },
      burnIsEstimated() {
        return !!this.summary.today_burn_estimated;
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
        const r = 88;
        const circ = 2 * Math.PI * r;
        // 只画 270°，与 .gauge-track 的 414.7 / 138.2 同口径
        const arc = circ * 0.75;
        const pct = goal ? Math.min(intake / goal, 1) : 0;
        const len = arc * pct;
        return {
          strokeDasharray: `${len.toFixed(2)} ${circ.toFixed(2)}`,
        };
      },
      // 页面编号，让顶栏标题像「第几号量表」而不是普通 h1
      navIndex() {
        const i = this.navItems.findIndex((n) => n.key === this.view);
        return String((i < 0 ? 0 : i) + 1).padStart(2, "0");
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
      // 图片识别结果的分组展示，结构与「粘贴文本」的解析预览一致
      mealPreviewGroups() {
        if (!this.mealPreview) return {};
        const out = {};
        for (const type of ["diet", "workout", "body"]) {
          const rows = this.mealPreview[type];
          if (rows && rows.length) out[type] = rows;
        }
        return out;
      },
      mealPreviewTotal() {
        const p = this.mealPreview;
        if (!p) return 0;
        return ["diet", "workout", "body"].reduce(
          (sum, type) => sum + ((p[type] || []).length), 0
        );
      },
      // 没入库的都算待处理：待识别、识别过但没确认、上次失败的
      mealPendingCount() {
        return this.mealImages.filter((img) => img.status !== "imported").length;
      },
      mealBusy() {
        return this.mealUploading || this.mealAnalyzing;
      },
      kpis() {
        const s = this.statsData;
        if (!s) return [];
        const a = s.averages || {};
        const t = s.totals || {};
        // raw 给数字滚动用，value 仍保留格式化字符串做兜底
        const num = (v, dec) => (v == null || isNaN(Number(v)) ? null : Number(v));
        return [
          { label: "日均摄入", value: this.fmt(a.diet_calories, 0), raw: num(a.diet_calories), dec: 0, unit: "kcal" },
          { label: "日均训练消耗", value: this.fmt(a.workout_calories, 0), raw: num(a.workout_calories), dec: 0, unit: "kcal" },
          { label: "训练天数", value: this.fmt(t.workout_days, 0), raw: num(t.workout_days), dec: 0, unit: "d" },
          { label: "平均体重", value: this.fmt(a.weight, 1), raw: num(a.weight), dec: 1, unit: "kg" },
          { label: "饮食条数", value: this.fmt(t.diet_records, 0), raw: num(t.diet_records), dec: 0, unit: "" },
          {
            label: "目标差距",
            value: s.goal_gap == null ? "—" : (s.goal_gap >= 0 ? "+" : "") + this.fmt(s.goal_gap, 0),
            raw: num(s.goal_gap),
            dec: 0,
            sign: s.goal_gap != null && s.goal_gap >= 0 ? "+" : "",
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
      // 与后端缺口口径一致：基准消耗（当天实时/最近实测/公式TDEE）− 净摄入。
      // 拆成「词 + 数值」两段，数值交给 v-num 滚动，词保持静态，避免动画时文字抖。
      deficitSplit() {
        const burn = this.todayBurn || this.measuredBurn || this.summary.tdee;
        const s = this.summary;
        const intake = s.diet.total.calories || 0;
        const net = this.measuredBurn ? intake : intake - (s.workout.total.calories || 0);
        if (!burn) return { word: "", value: null };
        const d = burn - net;
        return { word: d >= 0 ? "缺口" : "盈余", value: Math.abs(d) };
      },
      deficitWord() {
        return this.deficitSplit.word;
      },
      deficitValue() {
        return this.deficitSplit.value;
      },
      deficitDisplay() {
        const d = this.deficitSplit;
        if (d.value === null) return "—";
        return d.word + " " + this.fmt(d.value, 0) + " kcal";
      },
      deficitColor() {
        const band = this.summary.deficit_band;
        return (band && TONE_COLOR[band.tone]) || "#6b7280";
      },
    },

    mounted() {
      this.theme = localStorage.getItem("fit-theme") || "light";
      this.applyTheme();
      // 动效/音效偏好从 localStorage 读回来，界面开关只是镜像
      if (window.FX) {
        this.soundOn = FX.sound.on();
        this.soundVol = FX.sound.volume();
        this.motion = FX.getMotion();
        this.$nextTick(() => FX.refreshScroll());
      }
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
    watch: {
      theme() { this.applyTheme(); },
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
      async api(path, body, method) {
        const opts = { headers: {} };
        if (method) opts.method = method;
        else if (body) opts.method = "POST";
        if (body) {
          opts.headers["Content-Type"] = "application/json";
          opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);
        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          /* 忽略空响应体 */
        }
        if (!res.ok) {
          const msg = data && (data.detail || data.error) ? data.detail || data.error : "HTTP " + res.status;
          throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
        }
        return data;
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
        const tone = opts.tone || "ok";
        this.toast = { text: opts.text, tone };
        if (this._toastTimer) clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
          this.toast = null;
        }, 2600);
        // 结果音：成功是继电器闭合，失败是两声钝响，都不带旋律
        if (window.FX) {
          FX.sound.play(tone === "ok" ? "commit" : "error");
          if (tone !== "ok") FX.haptic(14);
        }
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
        const changed = this.view !== key;
        this.view = key;
        this.navOpen = false;
        this.onEnterView(key);
        if (changed) {
          // 换页回到顶部：从半页高的位置进入新页面没有意义
          const sc = document.querySelector(".scroll");
          if (sc) sc.scrollTop = 0;
          if (window.FX) this.$nextTick(() => FX.refreshScroll());
        }
      },
      onEnterView(key) {
        if (key === "today") this.loadToday();
        else if (key === "diet") {
          this.loadRecords("diet");
          this.loadMealImages();
        }
        else if (key === "workout") {
          this.loadRecords("workout");
          // 全天消耗跟着当天数据走，训练页顶部要显示手表的累计消耗
          this.loadToday();
          this.loadGarminStatus();
        } else if (key === "body") {
          this.loadBodyHistory();
          this.loadBodyTrend();
          this.loadToday();
          this.loadGarminStatus();
        } else if (key === "stats") this.loadStats();
        else if (key === "reports") this.loadReports();
        else if (key === "settings") this.loadSettings();
      },

      // ---------------------------------------------------------- AI 日报 / 佳明
      async loadReports() {
        const data = await this.api("/api/reports");
        this.reportsList = data.reports || [];
        if (this.reportsList.length) this.openReport(this.reportsList[0].date);
      },
      async openReport(date) {
        this.reportBusy = true;
        try {
          const data = await this.api(`/api/reports/${date}?html=true`);
          this.reportCurrent = data.report;
        } finally {
          this.reportBusy = false;
        }
      },
      async generateReport() {
        this.reportBusy = true;
        try {
          await this.api("/api/reports/generate", {
            date: this.selectedDate,
            force: true,
          });
          await this.loadReports();
          this.notify({ text: "日报已生成" });
        } finally {
          this.reportBusy = false;
        }
      },
      async loadGarminStatus() {
        try {
          this.garminStatus = await this.api("/api/garmin/status");
        } catch (e) {
          this.garminStatus = { configured: false };
        }
      },
      async garminSync() {
        this.garminBusy = true;
        try {
          const res = await this.api("/api/garmin/sync", { days: 7 });
          const weighIns = (res && res.weights) ? Object.keys(res.weights).length : 0;
          this.notify({
            text: weighIns ? `佳明数据已同步（含 ${weighIns} 天体重）` : "佳明数据已同步",
          });
          await Promise.all([this.loadGarminStatus(), this.loadToday(), this.loadBodyHistory()]);
        } finally {
          this.garminBusy = false;
        }
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
      // 日期左右箭头：按天前后切换选中日期，并刷新当前页数据
      shiftDate(delta) {
        const d = new Date(this.selectedDate + "T00:00:00");
        if (isNaN(d.getTime())) return;
        d.setDate(d.getDate() + delta);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        this.selectedDate = y + "-" + m + "-" + day;
        this.onDateChange();
      },
      applyTheme() {
        const html = document.documentElement;
        // :root 本身就是浅色，auto/light 都不用挂属性；只有 dark 需要显式挂
        if (this.theme === "dark") html.setAttribute("data-theme", "dark");
        else if (this.theme === "auto") html.removeAttribute("data-theme");
        else html.setAttribute("data-theme", "light");
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
          meta.setAttribute("content",
            this.isDark() ? "#080a0b" : "#ebe7dd");
        }
      },
      cycleTheme() {
        const order = ["light", "dark", "auto"];
        this.theme = order[(order.indexOf(this.theme) + 1) % order.length];
        localStorage.setItem("fit-theme", this.theme);
        this.applyTheme();
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

      // ---------------------------------------------------------- 音效与动效
      toggleSound() {
        if (!window.FX) return;
        this.soundOn = !this.soundOn;
        FX.sound.setOn(this.soundOn);
        if (this.soundOn) {
          FX.sound.unlock();
          FX.sound.play("commit");
        }
      },
      onVolume() {
        if (window.FX) FX.sound.setVolume(this.soundVol);
      },
      testSound() {
        if (!window.FX) return;
        FX.sound.setOn(true);
        this.soundOn = true;
        FX.sound.unlock();
        FX.sound.play("commit");
      },
      cycleMotion() {
        const order = ["auto", "full", "reduced"];
        this.motion = order[(order.indexOf(this.motion) + 1) % order.length];
        if (window.FX) FX.setMotion(this.motion);
        this.notify({ text: "动效：" + this.motionLabel, tone: "ok" });
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
      // 新入库的那一行闪一下，减少「到底写进去了没有」的疑问
      flashNew(res) {
        const row = res && res.records && res.records[0];
        if (!row || row.id == null || !window.FX) return;
        this.$nextTick(() => {
          setTimeout(() => FX.flashById(row.id), 30);
        });
      },

      async removeRecord(type, row) {
        // 先让这一行退场，再真删；删失败时数据还在，界面会重新拉回来
        const el = window.FX ? FX.byId(row.id) : null;
        if (el) await new Promise((resolve) => FX.leave(el, resolve));
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
          // 删失败就把行拉回来，别让用户以为已经删掉了
          if (el) el.classList.remove("fx-leaving");
          this.notify({ text: "删除失败：" + e.message, tone: "error" });
        }
      },
      async submitForm(type) {
        this.busy = true;
        let created = null;
        try {
          if (type === "diet") {
            const f = this.dietForm;
            const payload = {
              date: this.selectedDate,
              meal_type: f.meal_type,
              food_name: f.food_name,
              amount: f.amount || null,
              calories: this.num(f.calories),
              protein: this.num(f.protein),
              fat: this.num(f.fat),
              carbs: this.num(f.carbs),
            };
            created = await this.api("/api/records/diet", payload, "POST");
            this.dietForm = { meal_type: "午餐", food_name: "", amount: "", calories: "", protein: "", fat: "", carbs: "" };
            this.notify({ text: "已添加饮食", tone: "ok" });
          } else if (type === "workout") {
            const f = this.workoutForm;
            const payload = {
              date: this.selectedDate,
              category: f.category,
              duration_min: this.num(f.duration_min),
              calories: this.num(f.calories),
              note: f.note || null,
            };
            created = await this.api("/api/records/workout", payload, "POST");
            this.workoutForm = { category: "有氧", duration_min: "", calories: "", note: "" };
            this.notify({ text: "已添加训练", tone: "ok" });
          } else if (type === "body") {
            const f = this.bodyForm;
            const payload = { date: this.selectedDate, weight: this.num(f.weight), body_fat: this.num(f.body_fat), waist: this.num(f.waist) };
            created = await this.api("/api/records/body", payload, "POST");
            this.bodyForm = { weight: "", body_fat: "", waist: "" };
            this.notify({ text: "已记录身体数据", tone: "ok" });
          }
          await this.refreshData();
          this.flashNew(created);
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
          const via = res.tier === "llm" ? "（AI 兜底解析）" : "（本地规则，未耗额度）";
          this.notify({ text: "已导入 " + res.count + " 条" + via, tone: "ok" });
          this.pasteText = "";
          this.parsePreview = null;
          await this.refreshData();
          this.flashNew(res);
        } catch (e) {
          this.notify({ text: "导入失败：" + e.message, tone: "error" });
        } finally {
          this.busy = false;
        }
      },
      // ---- 图片分析：上传 → 识别 → 确认入库 ----

      mealStatusText(status) {
        return {
          pending: "待识别",
          analyzed: "已识别",
          imported: "已入库",
          failed: "识别失败",
        }[status] || status;
      },
      async loadMealImages() {
        try {
          const data = await this.api(
            "/api/meals?date=" + encodeURIComponent(this.selectedDate)
          );
          this.mealImages = data.images || [];
        } catch (e) {
          this.notify({ text: "加载图片失败：" + e.message, tone: "error" });
        }
      },
      onMealPick(event) {
        const files = Array.from(event.target.files || []);
        // 清空 value，否则连选同一张照片不会再触发 change
        event.target.value = "";
        this.uploadMealFiles(files);
      },
      onMealDrop(event) {
        this.mealDrag = false;
        if (window.FX) FX.sound.play("drop");
        this.uploadMealFiles(Array.from(event.dataTransfer.files || []));
      },
      async uploadMealFiles(files) {
        const images = files.filter((f) => (f.type || "").startsWith("image/"));
        if (!images.length) {
          this.notify({ text: "没有可上传的图片", tone: "error" });
          return;
        }
        this.mealUploading = true;
        try {
          const form = new FormData();
          images.forEach((file) => form.append("files", file));
          form.append("date", this.selectedDate);
          const res = await fetch("/api/meals/upload", { method: "POST", body: form });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error((data && (data.detail || data.error)) || "HTTP " + res.status);
          }
          const ok = (data.saved || []).length;
          const bad = (data.failed || []).length;
          this.mealErrors = (data.failed || []).map((f) => f.name + "：" + f.error);
          this.notify({
            text: bad ? `已上传 ${ok} 张，${bad} 张失败` : `已上传 ${ok} 张`,
            tone: bad ? "error" : "ok",
          });
          await this.loadMealImages();
        } catch (e) {
          this.notify({ text: "上传失败：" + e.message, tone: "error" });
        } finally {
          this.mealUploading = false;
        }
      },
      async deleteMealImage(id) {
        try {
          await this.api("/api/meals/" + id, null, "DELETE");
          this.mealImages = this.mealImages.filter((img) => img.id !== id);
        } catch (e) {
          this.notify({ text: "删除失败：" + e.message, tone: "error" });
        }
      },
      async analyzeMeals() {
        this.mealAnalyzing = true;
        this.mealErrors = [];
        try {
          const res = await this.api(
            "/api/meals/analyze",
            { date: this.selectedDate },
            "POST"
          );
          this.mealErrors = (res.analyzed || [])
            .filter((item) => !item.ok)
            .map((item) => (item.original || "图片") + "：" + item.error);
          if (res.parsed) {
            this.mealPreview = res.parsed;
            const total = ["diet", "workout", "body"].reduce(
              (sum, type) => sum + ((res.parsed[type] || []).length),
              0
            );
            this.notify({
              text: total ? `识别出 ${total} 条，确认后入库` : "没能识别出记录",
              tone: total ? "ok" : "error",
            });
          } else {
            this.mealPreview = null;
            this.notify({ text: "没有识别到内容", tone: "error" });
          }
          await this.loadMealImages();
        } catch (e) {
          this.notify({ text: "识别失败：" + e.message, tone: "error" });
        } finally {
          this.mealAnalyzing = false;
        }
      },
      async commitMealPreview() {
        if (!this.mealPreview) return;
        this.busy = true;
        try {
          let saved = 0;
          for (const type of ["diet", "workout", "body"]) {
            const rows = this.mealPreview[type] || [];
            if (!rows.length) continue;
            const res = await this.api("/api/records/" + type, { records: rows }, "POST");
            saved += (res.records || []).length || rows.length;
          }
          // 把这批图片标成已入库，否则它们会一直被当成待处理
          const ids = this.mealImages
            .filter((img) => img.status !== "imported")
            .map((img) => img.id);
          if (ids.length) {
            await this.api("/api/meals/mark-imported", { ids }, "POST");
          }
          this.mealPreview = null;
          this.notify({ text: "已入库 " + saved + " 条", tone: "ok" });
          await this.refreshData();
          await this.loadMealImages();
        } catch (e) {
          this.notify({ text: "入库失败：" + e.message, tone: "error" });
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
      exportData(format, record_type) {
        let url = "/api/export?format=" + format;
        if (record_type) url += "&record_type=" + record_type;
        window.location.href = url;
      },
      // 读 JSON 文件：先按严格 UTF-8 解码，失败回退 GBK（覆盖备份文件被
      // 微信/邮件等中间环节按 GBK 转码后再发的常见场景），解析前剥 UTF-8 BOM。
      async readJsonText(file) {
        const buf = await file.arrayBuffer();
        let text = "";
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch (_) {
          try {
            text = new TextDecoder("gbk").decode(buf);
          } catch (e2) {
            throw new Error("文件编码不识别（仅支持 UTF-8 / GBK）");
          }
        }
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return text;
      },
      async importData(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        try {
          const text = await this.readJsonText(file);
          const data = JSON.parse(text);
          const res = await this.api("/api/import", { data: data, replace: false }, "POST");
          const imported = (res && res.imported) || {};
          const total = Object.keys(imported).reduce((sum, k) => sum + (Number(imported[k]) || 0), 0);
          if (total > 0) {
            this.notify({ text: "已导入 " + total + " 条记录", tone: "ok" });
          } else {
            this.notify({ text: "没有可导入的记录（文件格式或内容为空）", tone: "warn" });
          }
          await this.refreshData();
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
      baseOptions(kind, opts) {
        // 全部取 CSS 变量，主题一动图表跟着变，不用在这里维护第二套配色
        const grid = cssVar("--chart-grid", "rgba(255,255,255,.055)");
        const tick = cssVar("--chart-tick", "#7d848e");
        const legendLabel = cssVar("--text-2", "#a1a7b1");

        const tooltipBg = cssVar("--surface-3", "#1f2227");
        const tooltipText = cssVar("--text", "#f2f3f5");
        const tooltipTitle = cssVar("--text-3", "#7d848e");
        const tooltipBorder = cssVar("--line-strong", "rgba(255,255,255,.14)");

        const legend = {
          position: "bottom",
          align: "start",
          labels: {
            color: legendLabel,
            boxWidth: 8,
            boxHeight: 8,
            padding: 16,
            usePointStyle: true,
            pointStyle: "rectRounded",
            font: { size: 11, weight: "500" },
          },
        };

        const scales = {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: tick, padding: 10, maxTicksLimit: 8, font: { size: 10.5 } },
          },
          y: {
            grid: { color: grid, drawTicks: false, lineWidth: 1 },
            border: { display: false },
            beginAtZero: true,
            grace: "8%",
            ticks: { color: tick, padding: 10, maxTicksLimit: 5, font: { size: 10.5 } },
          },
        };

        const tooltip = {
          backgroundColor: tooltipBg,
          titleColor: tooltipTitle,
          bodyColor: tooltipText,
          borderColor: tooltipBorder,
          borderWidth: 1,
          padding: { x: 12, y: 10 },
          cornerRadius: 8,
          displayColors: true,
          boxWidth: 7,
          boxHeight: 7,
          usePointStyle: true,
          titleFont: { size: 10.5, weight: "600" },
          bodyFont: { size: 12, weight: "500" },
          caretSize: 5,
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
          // 体重这类趋势图不该从 0 起算，否则几公斤的变化会被压成一条直线
          const zero = !(opts && opts.zero === false);
          scales.y.beginAtZero = zero;
          scales.y.grace = zero ? "8%" : "16%";
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
        const w = cssVar("--chart-2", "#35d0a5");
        const grad = ctx
          ? ctx.createLinearGradient(0, 0, 0, canvas.height || 280)
          : null;
        if (grad) {
          grad.addColorStop(0, alpha(w, .3));
          grad.addColorStop(1, alpha(w, 0));
        }
        this.renderChart("bodyChart", {
          type: "line",
          data: {
            labels: this.bodySeries.days,
            datasets: [
              {
                label: "体重 kg",
                data: this.bodySeries.weight,
                borderColor: w,
                backgroundColor: grad || alpha(w, .16),
                pointBackgroundColor: w,
                spanGaps: true,
                fill: true,
              },
            ],
          },
          options: this.baseOptions("line", { zero: false }),
        });
      },
      renderStatsCharts() {
        const s = this.statsData;
        if (!s) return;
        const days = s.series.days;

        // 摄入 / 消耗两条线：橙 = 吃进来，蓝 = 练出去
        const intake = cssVar("--chart-1", "#ff5c33");
        const burn = cssVar("--chart-4", "#7aa2ff");
        const cCalCanvas = this.$refs.calorieChart;
        const cCalCtx = cCalCanvas ? cCalCanvas.getContext("2d") : null;
        const intakeGrad = cCalCtx
          ? cCalCtx.createLinearGradient(0, 0, 0, cCalCanvas.height || 280)
          : null;
        if (intakeGrad) {
          intakeGrad.addColorStop(0, alpha(intake, .17));
          intakeGrad.addColorStop(1, alpha(intake, 0));
        }
        const burnGrad = cCalCtx
          ? cCalCtx.createLinearGradient(0, 0, 0, cCalCanvas.height || 280)
          : null;
        if (burnGrad) {
          burnGrad.addColorStop(0, alpha(burn, .12));
          burnGrad.addColorStop(1, alpha(burn, 0));
        }
        this.renderChart("calorieChart", {
          type: "line",
          data: {
            labels: days,
            datasets: [
              {
                label: "摄入",
                data: s.series.diet_calories,
                borderColor: intake,
                backgroundColor: intakeGrad || alpha(intake, .16),
                pointBackgroundColor: intake,
                fill: true,
              },
              {
                label: "训练消耗",
                data: s.series.workout_calories,
                borderColor: burn,
                backgroundColor: burnGrad || alpha(burn, .16),
                pointBackgroundColor: burn,
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
                  backgroundColor: [
                    cssVar("--chart-1", "#ff5c33"),
                    cssVar("--chart-3", "#ffc247"),
                    cssVar("--chart-4", "#7aa2ff"),
                  ],
                  borderColor: cssVar("--bg", "#07080a"),
                  borderWidth: 3,
                  spacing: 2,
                  hoverOffset: 4,
                  cutout: "76%",
                },
              ],
            },
            options: this.baseOptions("doughnut"),
          });
        } else {
          this.clearChart("macroChart");
        }

        // 训练部位分布：单系列柱，统一用强调色，避免八种颜色互相抢
        const cat = s.category_minutes || {};
        const catLabels = Object.keys(cat);
        const catValues = Object.values(cat);
        if (catLabels.length) {
          const bar = cssVar("--chart-1", "#ff5c33");
          this.renderChart("categoryChart", {
            type: "bar",
            data: {
              labels: catLabels,
              datasets: [
                {
                  label: "min",
                  data: catValues,
                  backgroundColor: alpha(bar, .78),
                  hoverBackgroundColor: bar,
                  borderRadius: 0,
                  maxBarThickness: 34,
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
        const wColor = cssVar("--chart-2", "#35d0a5");
        const wGrad = wCtx
          ? wCtx.createLinearGradient(0, 0, 0, wCanvas.height || 280)
          : null;
        if (wGrad) {
          wGrad.addColorStop(0, alpha(wColor, .16));
          wGrad.addColorStop(1, alpha(wColor, 0));
        }
        this.renderChart("weightChart", {
          type: "line",
          data: {
            labels: days,
            datasets: [
              {
                label: "体重 kg",
                data: s.series.weight,
                borderColor: wColor,
                backgroundColor: wGrad || alpha(wColor, .16),
                pointBackgroundColor: wColor,
                spanGaps: true,
                fill: true,
              },
            ],
          },
          options: this.baseOptions("line", { zero: false }),
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
      chatMessages() {
        this.$nextTick(() => this.scrollChat());
      },
      pending() {
        this.$nextTick(() => this.scrollChat());
      },
    },
  });

  // 数字滚动指令：模板里给空元素挂 v-num，文本由 fx.js 接管。
  // fx.js 没加载成功时退化成直接写文本，至少不会把主数字留空。
  if (window.FX && FX.numDirective) {
    app.directive("num", FX.numDirective);
  } else {
    const paintFallback = (el, v) => {
      const dec = parseInt(el.getAttribute("data-dec") || "0", 10) || 0;
      const n = Number(v);
      el.textContent = isFinite(n) && v !== null && v !== "" ? n.toFixed(dec) : "—";
    };
    app.directive("num", {
      mounted: (el, b) => paintFallback(el, b.value),
      updated: (el, b) => paintFallback(el, b.value),
    });
  }

  app.mount("#app");
})();
