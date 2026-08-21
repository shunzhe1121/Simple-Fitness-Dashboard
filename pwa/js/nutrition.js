/* 营养计算（移植自 app/nutrition.py）：BMR/TDEE/目标/宏量/缺口分级。 */
(function () {
  "use strict";

  var ACTIVITY_LEVELS = {
    sedentary: { factor: 1.2, label: "久坐（几乎不运动）" },
    light: { factor: 1.375, label: "轻度活动（每周 1-3 次）" },
    moderate: { factor: 1.55, label: "中度活动（每周 3-5 次）" },
    active: { factor: 1.725, label: "高强度（每周 6-7 次）" },
    very_active: { factor: 1.9, label: "极高强度（体力工作或双练）" },
  };

  var GOAL_TYPES = {
    cut: { label: "减脂", calorie_ratio: 0.80, protein_per_kg: 2.0, fat_per_kg: 0.8 },
    maintain: { label: "维持", calorie_ratio: 1.00, protein_per_kg: 1.6, fat_per_kg: 0.9 },
    bulk: { label: "增肌", calorie_ratio: 1.10, protein_per_kg: 1.8, fat_per_kg: 0.9 },
  };

  var ACTIVITY_ALIASES = {
    "久坐": "sedentary", "不运动": "sedentary",
    "轻度": "light", "偶尔运动": "light",
    "中度": "moderate", "经常运动": "moderate",
    "高强度": "active", "高度": "active",
    "极高": "very_active", "运动员": "very_active",
  };

  var GOAL_ALIASES = {
    "减脂": "cut", "减肥": "cut", "减重": "cut",
    "维持": "maintain", "保持": "maintain",
    "增肌": "bulk", "增重": "bulk", "增肌增重": "bulk",
  };

  function normalizeActivity(value) {
    if (!value) return "moderate";
    var text = String(value).trim();
    if (Object.prototype.hasOwnProperty.call(ACTIVITY_LEVELS, text)) return text;
    return ACTIVITY_ALIASES[text] || "moderate";
  }
  function normalizeGoal(value) {
    if (!value) return "maintain";
    var text = String(value).trim();
    if (Object.prototype.hasOwnProperty.call(GOAL_TYPES, text)) return text;
    return GOAL_ALIASES[text] || "maintain";
  }
  function normalizeGender(value) {
    var text = String(value || "").trim().toLowerCase();
    if (["male", "男", "男性", "m"].indexOf(text) >= 0) return "male";
    if (["female", "女", "女性", "f"].indexOf(text) >= 0) return "female";
    return "male";
  }

  /** Mifflin-St Jeor 公式。 */
  function calcBmr(weight, height, age, gender) {
    var base = 10 * weight + 6.25 * height - 5 * age;
    return normalizeGender(gender) === "male" ? base + 5 : base - 161;
  }

  /** 推算 BMR/TDEE/每日热量/宏量分配。 */
  function calcPlan(weight, height, age, gender, activityLevel, goalType) {
    weight = parseFloat(weight);
    height = parseFloat(height);
    age = parseInt(age, 10);

    var activityKey = normalizeActivity(activityLevel);
    var goalKey = normalizeGoal(goalType);
    var genderKey = normalizeGender(gender);
    var activity = ACTIVITY_LEVELS[activityKey];
    var goal = GOAL_TYPES[goalKey];

    var bmr = calcBmr(weight, height, age, genderKey);
    var tdee = bmr * activity.factor;
    var dailyCalories = tdee * goal.calorie_ratio;

    var proteinG = weight * goal.protein_per_kg;
    var fatG = weight * goal.fat_per_kg;
    var carbsG = Math.max((dailyCalories - proteinG * 4 - fatG * 9) / 4, 0);

    return {
      bmr: Math.round(bmr * 10) / 10,
      tdee: Math.round(tdee * 10) / 10,
      daily_calories: Math.round(dailyCalories * 10) / 10,
      protein_g: Math.round(proteinG * 10) / 10,
      fat_g: Math.round(fatG * 10) / 10,
      carbs_g: Math.round(carbsG * 10) / 10,
      activity_level: activityKey,
      goal_type: goalKey,
      gender: genderKey,
      explain:
        "基础代谢 " + Math.round(bmr) + " 千卡（Mifflin-St Jeor），" +
        "乘活动系数 " + activity.factor + "（" + activity.label + "）" +
        "得每日消耗 " + Math.round(tdee) + " 千卡；" +
        "按" + goal.label + "目标取 " + Math.round(goal.calorie_ratio * 100) + "%，" +
        "每日摄入建议 " + Math.round(dailyCalories) + " 千卡，" +
        "蛋白质 " + Math.round(proteinG) + " g、脂肪 " + Math.round(fatG) + " g、碳水 " + Math.round(carbsG) + " g。",
    };
  }

  /** 宏量克数反算热量占比。 */
  function macroCalories(protein, fat, carbs) {
    var proteinKcal = (protein || 0) * 4;
    var fatKcal = (fat || 0) * 9;
    var carbsKcal = (carbs || 0) * 4;
    var total = proteinKcal + fatKcal + carbsKcal;
    function share(v) { return total ? Math.round((v / total) * 1000) / 10 : 0; }
    return {
      protein_kcal: Math.round(proteinKcal * 10) / 10,
      fat_kcal: Math.round(fatKcal * 10) / 10,
      carbs_kcal: Math.round(carbsKcal * 10) / 10,
      total_kcal: Math.round(total * 10) / 10,
      protein_share: share(proteinKcal),
      fat_share: share(fatKcal),
      carbs_share: share(carbsKcal),
    };
  }

  function options() {
    return {
      activity_levels: Object.keys(ACTIVITY_LEVELS).map(function (k) {
        return { value: k, label: ACTIVITY_LEVELS[k].label, factor: ACTIVITY_LEVELS[k].factor };
      }),
      goal_types: Object.keys(GOAL_TYPES).map(function (k) {
        return { value: k, label: GOAL_TYPES[k].label };
      }),
    };
  }

  function missingProfileFields(profile) {
    var missing = [];
    if (!profile.height) missing.push("身高");
    if (!FitUtils.ageFromBirthYear(profile.birth_year)) missing.push("年龄或出生年份");
    if (!profile.gender) missing.push("性别");
    if (!profile.latest_weight) missing.push("体重");
    return missing;
  }

  // 热量缺口分级（移植自 nutrition.py DEFICIT_BANDS）
  var DEFICIT_BANDS = [
    { level: "extreme", label: "极速减脂", tone: "danger", min: 1000, desc: "每天缺口≥1000千卡，每周可能掉1kg以上，易掉肌肉、代谢下降、反弹，一般不建议。" },
    { level: "high", label: "高强度减脂", tone: "warn", min: 750, desc: "每天缺口750–1000千卡，每周约减0.7–0.9kg，适合有经验者短期冲刺，需盯紧蛋白质与微量营养。" },
    { level: "moderate", label: "中度减脂", tone: "ok", min: 500, desc: "每天缺口500–750千卡，每周约减0.5–0.7kg，强度与可持续性平衡，多数人推荐区间。" },
    { level: "mild", label: "轻度减脂", tone: "ok", min: 200, desc: "每天缺口200–500千卡，每周约减0.2–0.5kg，最温和、最容易长期坚持。" },
    { level: "maintain", label: "基本持平", tone: "neutral", min: -200, desc: "缺口在±200千卡内，摄入接近消耗，体重基本稳定。" },
    { level: "surplus", label: "热量盈余", tone: "warn", min: null, desc: "摄入高于消耗≥200千卡，体重易上升；增肌期可用，减脂期应避免。" },
  ];

  function classifyDeficit(deficit) {
    if (deficit === null || deficit === undefined) return null;
    for (var i = 0; i < DEFICIT_BANDS.length; i++) {
      var band = DEFICIT_BANDS[i];
      if (band.min === null || deficit >= band.min) {
        return { level: band.level, label: band.label, tone: band.tone, desc: band.desc };
      }
    }
    return null;
  }

  window.FitNutrition = {
    ACTIVITY_LEVELS: ACTIVITY_LEVELS,
    GOAL_TYPES: GOAL_TYPES,
    normalizeActivity: normalizeActivity,
    normalizeGoal: normalizeGoal,
    normalizeGender: normalizeGender,
    calcBmr: calcBmr,
    calcPlan: calcPlan,
    macroCalories: macroCalories,
    options: options,
    missingProfileFields: missingProfileFields,
    DEFICIT_BANDS: DEFICIT_BANDS,
    classifyDeficit: classifyDeficit,
  };
})();
