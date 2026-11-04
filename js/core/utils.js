/*!
 * utils.js —— 通用工具函数
 * ---------------------------------------------------------------
 * 纯逻辑、无 DOM 依赖，可直接复制到微信小程序中复用。
 * 同时兼容：浏览器全局（window.PrintSystem.Utils）与 CommonJS（require）。
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  }
  root.PrintSystem = root.PrintSystem || {};
  root.PrintSystem.Utils = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var DAY_MS = 86400000;

  /* ------------------------- 基础 ------------------------- */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** 生成唯一 ID */
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 7);
  }

  function nowTs() {
    return Date.now();
  }

  /** 把 'YYYY-MM-DD' / 'YYYY/MM/DD' / 时间戳 / Date 统一转成 Date */
  function toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(v);
    if (typeof v === 'string' && v) {
      var s = v.trim().replace(/\//g, '-');
      var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      var d = new Date(s);
      return d;
    }
    return new Date();
  }

  function toDateString(v) {
    var d = toDate(v);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function toTimeString(v) {
    var d = toDate(v);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function todayString() {
    return toDateString(new Date());
  }

  function weekdayCN(dateStr) {
    var d = toDate(dateStr);
    return isNaN(d.getTime()) ? '' : WEEKS[d.getDay()];
  }

  /** 两个日期相差多少天（to - from） */
  function diffDays(fromStr, toStr) {
    var a = toDate(fromStr), b = toDate(toStr);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
    a.setHours(0, 0, 0, 0);
    b.setHours(0, 0, 0, 0);
    return Math.round((b - a) / DAY_MS);
  }

  function addDays(dateStr, n) {
    var d = toDate(dateStr);
    d.setDate(d.getDate() + n);
    return toDateString(d);
  }

  /** 本周一（周一为一周起点） */
  function startOfWeek(dateStr) {
    var d = toDate(dateStr);
    var day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
    return toDateString(d);
  }

  function startOfMonth(dateStr) {
    var d = toDate(dateStr);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-01';
  }

  function monthKey(dateStr) {
    var d = toDate(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  /** '今天' / '昨天' / '3月5日 周三' */
  function formatDateHuman(dateStr) {
    var d = toDate(dateStr);
    if (isNaN(d.getTime())) return dateStr || '';
    var today = todayString();
    var diff = diffDays(dateStr, today);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    var sameYear = toDateString(d).slice(0, 4) === today.slice(0, 4);
    return (sameYear ? '' : d.getFullYear() + '年') +
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEKS[d.getDay()];
  }

  /** '03-05' 这种紧凑格式 */
  function formatDateShort(dateStr) {
    var d = toDate(dateStr);
    if (isNaN(d.getTime())) return dateStr || '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatTs(ts, withTime) {
    if (!ts) return '';
    return toDateString(ts) + (withTime ? ' ' + toTimeString(ts) : '');
  }

  /* ------------------------- 金额（单位：分） -------------------------
   * 金额统一使用「分」为整数存储，避免浮点误差。
   * 例如 0.2 元 => 20 分。
   * ------------------------------------------------------------------ */

  /** 分 => '1.20'（不带符号） */
  function fenToYuan(fen, symbol) {
    var v = Math.round(Number(fen) || 0);
    var neg = v < 0;
    v = Math.abs(v);
    var s = Math.floor(v / 100) + '.' + pad2(v % 100);
    return (neg ? '-' : '') + (symbol ? '¥' : '') + s;
  }

  /** 分 => '¥1.20' */
  function money(fen) {
    return fenToYuan(fen, true);
  }

  /** 数量展示：15 → '15'，15.5 → '15.5'，10 → '10'（去掉多余的 .0） */
  function qty(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    return String(Math.round(n * 10) / 10);
  }

  /** '0.2' / 0.2 / '¥0.2元' => 20 分 */
  function yuanToFen(input) {
    if (typeof input === 'number') {
      return isFinite(input) ? Math.round(input * 100) : 0;
    }
    var s = String(input == null ? '' : input).replace(/[^\d.\-]/g, '');
    var n = parseFloat(s);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  /* ------------------------- 数组 / 对象 ------------------------- */

  function sum(list, fn) {
    var total = 0;
    (list || []).forEach(function (item, i) {
      var v = fn ? fn(item, i) : item;
      if (typeof v === 'number' && isFinite(v)) total += v;
    });
    return total;
  }

  function groupBy(list, keyFn) {
    var map = {};
    (list || []).forEach(function (item) {
      var k = keyFn(item);
      if (!map[k]) map[k] = [];
      map[k].push(item);
    });
    return map;
  }

  function sortByDesc(list, fn) {
    return (list || []).slice().sort(function (a, b) {
      var va = fn(a), vb = fn(b);
      if (va === vb) return 0;
      return va < vb ? 1 : -1;
    });
  }

  function sortByAsc(list, fn) {
    return (list || []).slice().sort(function (a, b) {
      var va = fn(a), vb = fn(b);
      if (va === vb) return 0;
      return va > vb ? 1 : -1;
    });
  }

  function toInt(v, def) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return def || 0;
    return n;
  }

  function clampInt(v, min, max) {
    var n = toInt(v, min);
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    return n;
  }

  function deepClone(obj) {
    if (obj == null) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  function isBlank(v) {
    return v == null || String(v).trim() === '';
  }

  function trim(v) {
    return String(v == null ? '' : v).trim();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '"')
      .replace(/'/g, '&#39;');
  }

  /** 姓名排序：中文按拼音 */
  function compareName(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN');
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 200);
    };
  }

  /* ------------------------- CSV ------------------------- */

  function csvCell(v) {
    if (v == null) v = '';
    v = String(v);
    if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  /** rows: [[...],[...]] => CSV 字符串（不含 BOM） */
  function toCSV(rows) {
    return (rows || []).map(function (r) {
      return r.map(csvCell).join(',');
    }).join('\r\n');
  }

  /** 加 BOM，Excel 打开中文不乱码 */
  function excelCSV(rows) {
    return '\uFEFF' + toCSV(rows);
  }

  /** 猜分隔符：Excel 复制粘贴是制表符，另存为 CSV 是逗号 */
  function detectDelimiter(text) {
    var firstLine = String(text || '').split(/\r?\n/)[0] || '';
    var tabs = (firstLine.match(/\t/g) || []).length;
    var commas = (firstLine.match(/,/g) || []).length;
    return tabs > commas ? '\t' : ',';
  }

  /**
   * 解析 CSV / TSV 文本 => 二维数组
   * ---------------------------------------------------------------
   * 手写状态机，不用正则硬切（否则字段里的逗号、引号、换行全会炸）：
   *   - 支持 "带引号的字段"，内部 "" 表示一个引号，可以包含逗号和换行；
   *   - 自动识别逗号 / 制表符；去掉 BOM；
   *   - 跳过完全空行（Excel 末尾常有一堆空行）。
   */
  function parseCSV(text, opts) {
    var src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    var delim = (opts && opts.delimiter) || detectDelimiter(src);

    var rows = [], row = [], field = '', quoted = false;

    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);

      if (quoted) {
        if (ch === '"') {
          if (src.charAt(i + 1) === '"') { field += '"'; i++; }
          else quoted = false;
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') {
        quoted = true;
      } else if (ch === delim) {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (ch === '\r') {
        if (src.charAt(i + 1) !== '\n') {   // 单独的 \r 也算换行
          row.push(field); field = '';
          rows.push(row); row = [];
        }
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  return {
    WEEKS: WEEKS,
    pad2: pad2,
    uid: uid,
    nowTs: nowTs,
    toDate: toDate,
    toDateString: toDateString,
    toTimeString: toTimeString,
    todayString: todayString,
    weekdayCN: weekdayCN,
    diffDays: diffDays,
    addDays: addDays,
    startOfWeek: startOfWeek,
    startOfMonth: startOfMonth,
    monthKey: monthKey,
    formatDateHuman: formatDateHuman,
    formatDateShort: formatDateShort,
    formatTs: formatTs,
    fenToYuan: fenToYuan,
    money: money,
    qty: qty,
    yuanToFen: yuanToFen,
    sum: sum,
    groupBy: groupBy,
    sortByDesc: sortByDesc,
    sortByAsc: sortByAsc,
    toInt: toInt,
    clampInt: clampInt,
    deepClone: deepClone,
    isBlank: isBlank,
    trim: trim,
    escapeHtml: escapeHtml,
    compareName: compareName,
    debounce: debounce,
    csvCell: csvCell,
    toCSV: toCSV,
    excelCSV: excelCSV,
    detectDelimiter: detectDelimiter,
    parseCSV: parseCSV
  };
});
