/*!
 * pricing.js —— 计价规则（整个系统唯一的算钱地方）v3
 * ---------------------------------------------------------------
 * 规则（已简化到极致）：
 *   **只按张数计费，不再区分单面/双面。**
 *
 *       本次金额 = 张数 × 单价（默认 0.30 元/张）
 *
 * 金额内部一律用「分」为单位的整数计算，避免 0.1+0.2 浮点误差。
 * 以后要加彩色价、A3 价、会员价，改这一个文件 + 设置项即可，界面层不用动。
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  }
  root.PrintSystem = root.PrintSystem || {};
  root.PrintSystem.Pricing = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 默认定价（单位：分）。30 分 = 0.30 元/张 */
  var DEFAULT_PRICING = {
    priceFen: 30
  };

  var MAX_SHEETS = 99999;

  function toFen(v, def) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) n = def;
    return Math.round(n);
  }

  function toSheets(v) {
    var n = parseFloat(v);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.round(n * 2) / 2;        // 粒度：半张（0.5），避免 0.12 这种奇怪的值
    if (n > MAX_SHEETS) n = MAX_SHEETS;
    return n;
  }

  /** 张数展示：15 → '15'，15.5 → '15.5' */
  function qty(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    return String(Math.round(n * 10) / 10);
  }

  /**
   * 把任意（可能是旧版本/残缺的）定价对象补全成合法结构
   * 兼容 v1 的 { singlePriceFen, doublePriceFen }：优先取双面价作为统一价
   */
  function normalize(pricing) {
    pricing = pricing || {};
    var v;
    if (pricing.priceFen != null) v = pricing.priceFen;
    else if (pricing.doublePriceFen != null) v = pricing.doublePriceFen;
    else if (pricing.singlePriceFen != null) v = pricing.singlePriceFen;
    else v = DEFAULT_PRICING.priceFen;
    return { priceFen: toFen(v, DEFAULT_PRICING.priceFen) };
  }

  /**
   * 取张数。优先读 sheets；
   * 兼容旧数据：把 singleSheets 与 doubleSheets 相加。
   */
  function readSheets(input) {
    if (!input) return 0;
    if (input.sheets != null) return toSheets(input.sheets);
    return toSheets(input.singleSheets) + toSheets(input.doubleSheets);
  }

  /**
   * 计算一次打印的费用
   * @param {Object} input   { sheets }（也接受旧的 { singleSheets, doubleSheets }）
   * @param {Object} pricing { priceFen }
   * @return {Object} { sheets, unitPriceFen, amountFen, pricing }
   */
  function calculate(input, pricing) {
    var p = normalize(pricing);
    var sheets = readSheets(input);
    return {
      sheets: sheets,
      unitPriceFen: p.priceFen,                          // 单价（分/张）
      // 半张 × 奇数单价可能算出 12.5 分，四舍五入成整数分，保持「分」的完整性
      amountFen: Math.round(sheets * p.priceFen),        // 金额（分）
      pricing: p
    };
  }

  /**
   * 批量：同样一份张数 × 多个学生
   * @param {Number} people 人数
   * @return {Object} 在 calculate 的结果上追加 people / perAmountFen / totalAmountFen
   */
  function calculateBatch(people, input, pricing) {
    var r = calculate(input, pricing);
    var n = parseInt(people, 10);
    if (!isFinite(n) || n < 0) n = 0;
    return {
      people: n,
      sheets: r.sheets,
      unitPriceFen: r.unitPriceFen,
      perAmountFen: r.amountFen,           // 每人多少分
      totalAmountFen: r.amountFen * n,     // 合计多少分
      pricing: r.pricing
    };
  }

  /** '0.30 元/张' */
  function describe(pricing, withSymbol) {
    var p = normalize(pricing);
    var sym = withSymbol ? '¥' : '';
    return sym + (p.priceFen / 100).toFixed(2) + ' 元/张';
  }

  /** 展示用：'5 张 × 0.30 元/张' */
  function breakdown(input, pricing) {
    var r = calculate(input, pricing);
    if (r.sheets <= 0) return '尚未填写张数';
    return qty(r.sheets) + ' 张 × ' + (r.pricing.priceFen / 100).toFixed(2) + ' 元/张';
  }

  return {
    DEFAULT_PRICING: DEFAULT_PRICING,
    MAX_SHEETS: MAX_SHEETS,
    normalize: normalize,
    toSheets: toSheets,
    qty: qty,
    readSheets: readSheets,
    calculate: calculate,
    calculateBatch: calculateBatch,
    describe: describe,
    breakdown: breakdown
  };
});