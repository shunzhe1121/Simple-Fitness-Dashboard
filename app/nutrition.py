"""BMR、TDEE 与宏量营养素计算。

BMR 采用 Mifflin-St Jeor 公式，比旧的 Harris-Benedict 在现代人群上
误差更小；活动系数与目标调整幅度沿用常见的健身营养学取值。
计算结果只作参考基准，实际执行还要看体重变化趋势再校准。
"""

from __future__ import annotations

from . import utils

# 活动水平系数
ACTIVITY_LEVELS: dict[str, dict] = {
    "sedentary": {"factor": 1.2, "label": "久坐（几乎不运动）"},
    "light": {"factor": 1.375, "label": "轻度活动（每周 1-3 次）"},
    "moderate": {"factor": 1.55, "label": "中度活动（每周 3-5 次）"},
    "active": {"factor": 1.725, "label": "高强度（每周 6-7 次）"},
    "very_active": {"factor": 1.9, "label": "极高强度（体力工作或双练）"},
}

# 目标类型对应的热量调整与宏量系数（g/kg 体重）
GOAL_TYPES: dict[str, dict] = {
    "cut": {
        "label": "减脂",
        "calorie_ratio": 0.80,
        "protein_per_kg": 2.0,
        "fat_per_kg": 0.8,
    },
    "maintain": {
        "label": "维持",
        "calorie_ratio": 1.00,
        "protein_per_kg": 1.6,
        "fat_per_kg": 0.9,
    },
    "bulk": {
        "label": "增肌",
        "calorie_ratio": 1.10,
        "protein_per_kg": 1.8,
        "fat_per_kg": 0.9,
    },
}

# 中文别名，方便 Agent 直接透传用户的口语说法
ACTIVITY_ALIASES = {
    "久坐": "sedentary",
    "不运动": "sedentary",
    "轻度": "light",
    "偶尔运动": "light",
    "中度": "moderate",
    "经常运动": "moderate",
    "高强度": "active",
    "高度": "active",
    "极高": "very_active",
    "运动员": "very_active",
}

GOAL_ALIASES = {
    "减脂": "cut",
    "减肥": "cut",
    "减重": "cut",
    "维持": "maintain",
    "保持": "maintain",
    "增肌": "bulk",
    "增重": "bulk",
    "增肌增重": "bulk",
}


def normalize_activity(value: str | None) -> str:
    """把活动水平的各种写法归一化成内部键。"""
    if not value:
        return "moderate"
    text = str(value).strip()
    if text in ACTIVITY_LEVELS:
        return text
    return ACTIVITY_ALIASES.get(text, "moderate")


def normalize_goal(value: str | None) -> str:
    """把目标类型的各种写法归一化成内部键。"""
    if not value:
        return "maintain"
    text = str(value).strip()
    if text in GOAL_TYPES:
        return text
    return GOAL_ALIASES.get(text, "maintain")


def normalize_gender(value: str | None) -> str:
    """归一化性别，未识别时按男性计算并在结果里说明。"""
    text = str(value or "").strip().lower()
    if text in {"male", "男", "男性", "m"}:
        return "male"
    if text in {"female", "女", "女性", "f"}:
        return "female"
    return "male"


def calc_bmr(weight: float, height: float, age: int, gender: str) -> float:
    """Mifflin-St Jeor 公式计算基础代谢率（千卡/天）。"""
    base = 10 * weight + 6.25 * height - 5 * age
    return base + 5 if normalize_gender(gender) == "male" else base - 161


def calc_plan(
    weight: float,
    height: float,
    age: int,
    gender: str,
    activity_level: str | None = None,
    goal_type: str | None = None,
) -> dict:
    """由身体数据推算 BMR、TDEE、每日热量目标与三大宏量分配。

    参数:
        weight: 体重 kg
        height: 身高 cm
        age: 年龄
        gender: 性别
        activity_level: 活动水平
        goal_type: 目标类型（减脂/维持/增肌）

    返回:
        含 bmr、tdee、daily_calories、protein_g、fat_g、carbs_g 的字典，
        另附 explain 字段说明计算依据。
    """
    weight = float(weight)
    height = float(height)
    age = int(age)

    activity_key = normalize_activity(activity_level)
    goal_key = normalize_goal(goal_type)
    gender_key = normalize_gender(gender)

    activity = ACTIVITY_LEVELS[activity_key]
    goal = GOAL_TYPES[goal_key]

    bmr = calc_bmr(weight, height, age, gender_key)
    tdee = bmr * activity["factor"]
    daily_calories = tdee * goal["calorie_ratio"]

    protein_g = weight * goal["protein_per_kg"]
    fat_g = weight * goal["fat_per_kg"]
    # 碳水吃掉剩下的热量额度，蛋白 4 kcal/g、脂肪 9 kcal/g、碳水 4 kcal/g
    carbs_g = max((daily_calories - protein_g * 4 - fat_g * 9) / 4, 0)

    return {
        "bmr": round(bmr, 1),
        "tdee": round(tdee, 1),
        "daily_calories": round(daily_calories, 1),
        "protein_g": round(protein_g, 1),
        "fat_g": round(fat_g, 1),
        "carbs_g": round(carbs_g, 1),
        "activity_level": activity_key,
        "goal_type": goal_key,
        "gender": gender_key,
        "explain": (
            f"基础代谢 {bmr:.0f} 千卡（Mifflin-St Jeor），"
            f"乘活动系数 {activity['factor']}（{activity['label']}）"
            f"得每日消耗 {tdee:.0f} 千卡；"
            f"按{goal['label']}目标取 {goal['calorie_ratio']:.0%}，"
            f"每日摄入建议 {daily_calories:.0f} 千卡，"
            f"蛋白质 {protein_g:.0f} g、脂肪 {fat_g:.0f} g、碳水 {carbs_g:.0f} g。"
        ),
    }


def macro_calories(protein: float | None, fat: float | None, carbs: float | None) -> dict:
    """由三大宏量克数反算热量占比，用于统计页的营养素分布。"""
    protein_kcal = (protein or 0) * 4
    fat_kcal = (fat or 0) * 9
    carbs_kcal = (carbs or 0) * 4
    total = protein_kcal + fat_kcal + carbs_kcal

    def share(value: float) -> float:
        return round(value / total * 100, 1) if total else 0.0

    return {
        "protein_kcal": round(protein_kcal, 1),
        "fat_kcal": round(fat_kcal, 1),
        "carbs_kcal": round(carbs_kcal, 1),
        "total_kcal": round(total, 1),
        "protein_share": share(protein_kcal),
        "fat_share": share(fat_kcal),
        "carbs_share": share(carbs_kcal),
    }


def options() -> dict:
    """返回前端下拉框需要的活动水平与目标类型选项。"""
    return {
        "activity_levels": [
            {"value": key, "label": item["label"], "factor": item["factor"]}
            for key, item in ACTIVITY_LEVELS.items()
        ],
        "goal_types": [
            {"value": key, "label": item["label"]} for key, item in GOAL_TYPES.items()
        ],
    }


def missing_profile_fields(profile: dict) -> list[str]:
    """检查算 TDEE 还缺哪些资料，用于 Agent 主动追问。"""
    missing: list[str] = []
    if not profile.get("height"):
        missing.append("身高")
    if not utils.age_from_birth_year(profile.get("birth_year")):
        missing.append("年龄或出生年份")
    if not profile.get("gender"):
        missing.append("性别")
    if not profile.get("latest_weight"):
        missing.append("体重")
    return missing


# 热量缺口分级。
# 缺口 = 每日总消耗(TDEE) − 净摄入(饮食摄入 − 运动消耗)。
# 正值代表在制造缺口（倾向减脂），负值代表盈余（倾向增重）。
# 分级阈值取自常见健身营养学经验：每 7700 千卡缺口约对应 1kg 脂肪，
# 因此每天缺口 500 千卡 ≈ 每周减 0.5kg，属于推荐的中等强度。
DEFICIT_BANDS: list[dict] = [
    {
        "level": "extreme",
        "label": "极速减脂",
        "tone": "danger",
        "min": 1000,
        "desc": "每天缺口≥1000千卡，每周可能掉1kg以上，易掉肌肉、代谢下降、反弹，一般不建议。",
    },
    {
        "level": "high",
        "label": "高强度减脂",
        "tone": "warn",
        "min": 750,
        "desc": "每天缺口750–1000千卡，每周约减0.7–0.9kg，适合有经验者短期冲刺，需盯紧蛋白质与微量营养。",
    },
    {
        "level": "moderate",
        "label": "中度减脂",
        "tone": "ok",
        "min": 500,
        "desc": "每天缺口500–750千卡，每周约减0.5–0.7kg，强度与可持续性平衡，多数人推荐区间。",
    },
    {
        "level": "mild",
        "label": "轻度减脂",
        "tone": "ok",
        "min": 200,
        "desc": "每天缺口200–500千卡，每周约减0.2–0.5kg，最温和、最容易长期坚持。",
    },
    {
        "level": "maintain",
        "label": "基本持平",
        "tone": "neutral",
        "min": -200,
        "desc": "缺口在±200千卡内，摄入接近消耗，体重基本稳定。",
    },
    {
        "level": "surplus",
        "label": "热量盈余",
        "tone": "warn",
        "min": None,
        "desc": "摄入高于消耗≥200千卡，体重易上升；增肌期可用，减脂期应避免。",
    },
]


def classify_deficit(deficit: float | None) -> dict | None:
    """把热量缺口映射成档位信息（level/label/tone/desc）。

    档位按 min 阈值从高到低排列，difficit >= min 即落入该档；
    surplus 用 min=None 作为兜底，捕获所有低于 −200 的情况。
    """
    if deficit is None:
        return None
    for band in DEFICIT_BANDS:
        if band["min"] is None or deficit >= band["min"]:
            return {
                "level": band["level"],
                "label": band["label"],
                "tone": band["tone"],
                "desc": band["desc"],
            }
    return None
