/* 豆包模板文本解析器（移植自 app/parser.py）：按 ### 分块、键值提取、字段别名归一化。 */
(function () {
  "use strict";

  var ALIASES = {
    // 通用
    "类型": "_type", "分类": "_type", "type": "_type",
    "日期": "date", "date": "date",
    "备注": "note", "说明": "note", "note": "note",
    // 饮食
    "餐次": "meal_type", "餐": "meal_type", "meal": "meal_type",
    "食物": "food_name", "食品": "food_name", "名称": "food_name", "菜名": "food_name",
    "food": "food_name", "name": "food_name",
    "分量": "amount", "份量": "amount", "数量": "amount", "克数": "amount",
    "amount": "amount", "portion": "amount",
    "卡路里": "calories", "热量": "calories", "能量": "calories", "千卡": "calories",
    "calories": "calories", "kcal": "calories",
    "蛋白质": "protein", "蛋白": "protein", "protein": "protein",
    "脂肪": "fat", "fat": "fat",
    "碳水": "carbs", "碳水化合物": "carbs", "carbs": "carbs", "carbohydrate": "carbs",
    // 训练
    "部位": "category", "训练部位": "category", "category": "category",
    "项目": "_exercise", "动作": "_exercise", "运动": "_exercise", "exercise": "_exercise",
    "时长": "duration_min", "时间": "duration_min", "分钟": "duration_min", "duration": "duration_min",
    // 身体
    "体重": "weight", "weight": "weight",
    "体脂": "body_fat", "体脂率": "body_fat", "body_fat": "body_fat",
    "腰围": "waist", "waist": "waist",
  };

  var MEAL_ALIASES = {
    "早餐": "早餐", "早": "早餐", "早饭": "早餐", "breakfast": "早餐",
    "午餐": "午餐", "中餐": "午餐", "午": "午餐", "午饭": "午餐", "lunch": "午餐",
    "晚餐": "晚餐", "晚": "晚餐", "晚饭": "晚餐", "dinner": "晚餐",
    "加餐": "加餐", "零食": "加餐", "夜宵": "加餐", "snack": "加餐",
  };

  var EMPTY_VALUES = {
    "": true, "-": true, "--": true, "无": true, "未知": true, "不详": true,
    "不确定": true, "n/a": true, "na": true, "null": true, "none": true, "待补充": true,
  };

  var BLOCK_SPLIT = /#{3,}/;
  var FENCE = /^```[a-zA-Z]*\s*|\s*```$/gm;
  var KEY_VALUE = /^\s*([^:：]{1,20})[:：]\s*(.*)$/;

  function cleanText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      .replace(FENCE, "")
      .trim();
  }

  function splitBlocks(text) {
    var blocks;
    if (text.indexOf("###") >= 0) {
      blocks = text.split(BLOCK_SPLIT).map(function (b) { return b.trim(); });
    } else {
      blocks = text.split(/\n\s*\n/).map(function (b) { return b.trim(); });
    }
    blocks = blocks.filter(function (b) { return b; });
    var t = text.trim();
    return blocks.length ? blocks : (t ? [t] : []);
  }

  function parseBlock(block) {
    var fields = {};
    block.split("\n").forEach(function (line) {
      var matched = KEY_VALUE.exec(line);
      if (!matched) return;
      var rawKey = matched[1].trim().replace(/^[-*·•]+|[-*·•]+$/g, "").trim();
      var rawValue = matched[2].trim();
      var key = ALIASES[rawKey] || ALIASES[rawKey.toLowerCase()];
      if (!key) return;
      if (EMPTY_VALUES[rawValue.toLowerCase()]) return;
      fields[key] = rawValue;
    });
    return fields;
  }

  function inferType(fields) {
    var declared = String(fields._type || "").trim();
    if (declared) {
      if (/饮食|食物|餐|diet|food/.test(declared)) return "diet";
      if (/训练|运动|健身|workout/.test(declared)) return "workout";
      if (/身体|体重|体测|body/.test(declared)) return "body";
    }
    if (fields.food_name) return "diet";
    if (fields.category || fields._exercise || fields.duration_min) return "workout";
    if (fields.weight || fields.body_fat || fields.waist) return "body";
    return null;
  }

  function buildDiet(fields, defaultDate) {
    var mealRaw = String(fields.meal_type || "").trim();
    var meal = MEAL_ALIASES[mealRaw] || MEAL_ALIASES[mealRaw.toLowerCase()] || (mealRaw || null);
    return {
      // 修复：块内无日期时才用 defaultDate（用户选的日期），避免 resolveDate 直接回退到"今天"
      date: FitUtils.resolveDate(fields.date, false) || defaultDate,
      meal_type: meal,
      food_name: fields.food_name || null,
      amount: fields.amount || null,
      calories: FitUtils.toFloat(fields.calories),
      protein: FitUtils.toFloat(fields.protein),
      fat: FitUtils.toFloat(fields.fat),
      carbs: FitUtils.toFloat(fields.carbs),
      source: "template",
      note: fields.note || null,
    };
  }

  function buildWorkout(fields, defaultDate) {
    var exercise = fields._exercise;
    var category = fields.category || exercise || "未分类";
    var notes = [fields.note];
    if (exercise && fields.category) notes.unshift("项目：" + exercise);
    var note = notes.filter(Boolean).join(" / ") || null;
    return {
      date: FitUtils.resolveDate(fields.date, false) || defaultDate,
      category: category,
      duration_min: FitUtils.toFloat(fields.duration_min),
      calories: FitUtils.toFloat(fields.calories),
      note: note,
    };
  }

  function buildBody(fields, defaultDate) {
    return {
      date: FitUtils.resolveDate(fields.date, false) || defaultDate,
      weight: FitUtils.toFloat(fields.weight),
      body_fat: FitUtils.toFloat(fields.body_fat),
      waist: FitUtils.toFloat(fields.waist),
      note: fields.note || null,
    };
  }

  /**
   * 解析粘贴文本，返回 {diet, workout, body, unparsed, warnings}。
   * defaultDate: 块内没写日期时使用的日期，默认取今天。
   */
  function parse(text, defaultDate) {
    var day = FitUtils.resolveDate(defaultDate) || FitUtils.todayStr();
    var cleaned = cleanText(text);
    var result = { diet: [], workout: [], body: [], unparsed: [], warnings: [] };

    if (!cleaned) {
      result.warnings.push("粘贴内容为空");
      return result;
    }

    splitBlocks(cleaned).forEach(function (block) {
      var fields = parseBlock(block);
      if (!Object.keys(fields).length) {
        result.unparsed.push(block);
        return;
      }
      var recordType = inferType(fields);
      if (recordType === "diet") {
        var record = buildDiet(fields, day);
        if (!record.food_name) { result.unparsed.push(block); return; }
        result.diet.push(record);
      } else if (recordType === "workout") {
        result.workout.push(buildWorkout(fields, day));
      } else if (recordType === "body") {
        var b = buildBody(fields, day);
        if (b.weight === null && b.body_fat === null && b.waist === null) {
          result.unparsed.push(block);
          return;
        }
        result.body.push(b);
      } else {
        result.unparsed.push(block);
      }
    });

    var total = result.diet.length + result.workout.length + result.body.length;
    if (!total) {
      result.warnings.push("没能从文本里识别出任何记录，检查一下是否漏了 ### 分隔或字段名写法");
    }
    return result;
  }

  // 识图提示词（复制给豆包等视觉模型用）
  var DOUBAO_PROMPT = [
    "识别图片中的食物，严格按下面格式输出，不要加任何解释或前后缀文字。",
    "",
    "###",
    "餐次: 午餐",
    "食物: 米饭",
    "分量: 150g",
    "卡路里: 174",
    "蛋白质: 3.5",
    "脂肪: 0.4",
    "碳水: 38.5",
    "###",
    "",
    "规则：",
    "1. 每种食物独立包在一组 ### 之间，多种食物就输出多组",
    "2. 数值只写数字不带单位，分量保留单位",
    "3. 蛋白质、脂肪、碳水必须按图中实际分量估算并输出（参考常见食物营养表），",
    "   不确定时给合理估算值，不要省略整行；只有完全无法估计的菜式才可省略",
    "4. 其他无法确定的字段（如餐次）直接省略整行，不要写\"未知\"\"无\"\"0\"",
    "5. 营养素按实际分量计算，不是每 100g 的值",
  ].join("\n");

  window.FitParser = { parse: parse, DOUBAO_PROMPT: DOUBAO_PROMPT };
})();
