/* 工具函数（移植自 app/utils.py）：日期归一化 + 数值宽松解析。 */
(function () {
  "use strict";

  var RELATIVE_DAYS = {
    "今天": 0, "今日": 0, "本日": 0, "today": 0,
    "昨天": -1, "昨日": -1, "yesterday": -1,
    "前天": -2,
    "明天": 1, "tomorrow": 1,
  };
  var FULL_DATE = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/;
  var SHORT_DATE = /^(\d{1,2})[-/.月](\d{1,2})日?$/;
  var COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;

  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(y, m, d) { return y + "-" + pad(m) + "-" + pad(d); }
  function valid(y, m, d) {
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function shift(days) {
    var t = new Date();
    t.setDate(t.getDate() + days);
    return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }

  function todayStr() {
    var d = new Date();
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function nowStr() {
    var d = new Date();
    return todayStr() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  /** 把各种日期写法归一化为 YYYY-MM-DD；defaultToday=false 时解析失败返回 null。 */
  function resolveDate(value, defaultToday) {
    var fallback = defaultToday === false ? null : todayStr();
    if (value === null || value === undefined) return fallback;
    var text = String(value).trim();
    if (!text) return fallback;

    if (Object.prototype.hasOwnProperty.call(RELATIVE_DAYS, text)) {
      return shift(RELATIVE_DAYS[text]);
    }
    var m = text.match(/^(\d+)\s*天前$/);
    if (m) return shift(-parseInt(m[1], 10));

    m = FULL_DATE.exec(text) || COMPACT_DATE.exec(text);
    if (m) {
      var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
      return valid(y, mo, d) ? iso(y, mo, d) : fallback;
    }
    m = SHORT_DATE.exec(text);
    if (m) {
      var y2 = new Date().getFullYear(), mo2 = parseInt(m[1], 10), d2 = parseInt(m[2], 10);
      return valid(y2, mo2, d2) ? iso(y2, mo2, d2) : fallback;
    }
    return fallback;
  }

  /** 生成最近 N 天的闭区间 (起始, 结束)。 */
  function dateRange(days, end) {
    var span = Math.max(parseInt(days, 10) || 1, 1) - 1;
    var endStr = resolveDate(end) || todayStr();
    var p = endStr.split("-");
    var dt = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    dt.setDate(dt.getDate() - span);
    return [iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()), endStr];
  }

  /** 宽松转浮点，剥离常见单位与说明文字。 */
  function toFloat(value, def) {
    if (value === null || value === undefined) return def;
    if (typeof value === "number") return isNaN(value) ? def : value;
    var text = String(value).trim();
    if (!text) return def;
    var m = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!m) return def;
    var n = parseFloat(m[0]);
    return isNaN(n) ? def : n;
  }

  function toInt(value, def) {
    var r = toFloat(value, null);
    return r === null ? def : Math.round(r);
  }

  function roundOrNone(value, digits) {
    if (value === null || value === undefined) return null;
    var f = Math.pow(10, digits === undefined ? 1 : digits);
    return Math.round(value * f) / f;
  }

  function ageFromBirthYear(y) {
    if (!y) return null;
    var age = new Date().getFullYear() - parseInt(y, 10);
    return age > 0 && age < 130 ? age : null;
  }

  window.FitUtils = {
    todayStr: todayStr,
    nowStr: nowStr,
    resolveDate: resolveDate,
    dateRange: dateRange,
    toFloat: toFloat,
    toInt: toInt,
    roundOrNone: roundOrNone,
    ageFromBirthYear: ageFromBirthYear,
  };
})();
