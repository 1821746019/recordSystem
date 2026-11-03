/*!
 * core/pinyin.js —— 拼音搜索（可插拔 + 自动降级）
 * ---------------------------------------------------------------
 * 依赖：js/vendor/tiny-pinyin.js（vendor 版本，已内联，见 tools/vendor-pinyin.js）
 *
 * 提供两种能力：
 *   1) 汉字 → 拼音：full('张小明') = 'zhangxiaoming'，initials('张小明') = 'zxm'
 *   2) 模糊匹配打分：matchScore('张小明', 'zxm') → 80
 *      （原文 / 全拼 / 首字母 / 逐字前缀混合，如 zxm、xm、zhangxm、zxiaoming 都能命中）
 *
 * 环境不支持 Intl.Collator 中文排序时（极少数老环境），会自动降级成
 * 「只用原文匹配」，功能仍然可用，不会报错。降级状态见 Pinyin.mode。
 *
 * 按姓氏多音字由词库的 EXCEPTIONS 修正：曾→zeng、沈→shen、单→shan…
 */
(function (root, factory) {
  'use strict';
  var mod;
  if (typeof module !== 'undefined' && module.exports) {
    mod = factory(require('../vendor/tiny-pinyin.js'));
  } else {
    root.PrintSystem = root.PrintSystem || {};
    mod = factory(root.PrintSystem.vendorTinyPinyin);
  }
  root.PrintSystem = root.PrintSystem || {};
  root.PrintSystem.Pinyin = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (vendor) {
  'use strict';

  var HAN_START = 0x3400;      // 这个码点之后才当作汉字去做拼音转换
  var CACHE_LIMIT = 3000;      // 拼音缓存上限（一个店撑死几百个学生，足够）

  var enabled = false;
  try {
    enabled = !!(vendor && typeof vendor.convertToPinyin === 'function' && vendor.isSupported());
  } catch (e) {
    enabled = false;
  }

  var cache = {};
  var cacheCount = 0;

  function toLower(v) {
    return String(v == null ? '' : v).toLowerCase();
  }

  function isLatin(ch) {
    return /[a-z0-9]/i.test(ch);
  }

  /** 把一个字符串逐字拆成 { ch, py, ini } */
  function convert(text) {
    text = String(text == null ? '' : text);
    if (cache[text]) return cache[text];

    var chars = [];
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var py = '';
      if (ch.charCodeAt(0) >= HAN_START) {
        if (enabled) {
          try { py = toLower(vendor.convertToPinyin(ch, '', true)); } catch (e) { py = ''; }
        }
        // 转换不出来（生僻字/不支持）时留空，只影响拼音匹配
      } else if (isLatin(ch)) {
        py = toLower(ch);          // 数字、字母原样参与匹配
      }
      chars.push({
        ch: ch,
        py: py,                    // 全拼；非中文/未识别为 ''
        ini: py ? py.charAt(0) : ''
      });
    }

    var full = '';
    var initials = '';
    for (var j = 0; j < chars.length; j++) {
      full += chars[j].py;
      initials += chars[j].ini;
    }

    var result = { text: text, chars: chars, full: full, initials: initials };

    if (cacheCount > CACHE_LIMIT) { cache = {}; cacheCount = 0; }
    cache[text] = result;
    cacheCount++;
    return result;
  }

  /**
   * 从 chars[from] 开始，能否连续把 keyword 消耗完
   * 每个字贡献「全拼的前缀」（长度 1..n，长度为 1 就是首字母）
   * 非字母数字的字符（空格、-等）直接跳过
   * 注：用贪心（优先匹配更长的前缀），对姓名搜索足够；边界情况由「全拼包含」兜底
   */
  function consume(chars, from, kw) {
    var k = 0;
    var i = from;
    while (i < chars.length && k < kw.length) {
      var c = chars[i];
      if (!c.py) { i++; continue; }
      var maxLen = Math.min(c.py.length, kw.length - k);
      var hit = 0;
      for (var L = maxLen; L >= 1; L--) {
        if (c.py.substr(0, L) === kw.substr(k, L)) { hit = L; break; }
      }
      if (!hit) return false;
      k += hit;
      i++;
    }
    return k >= kw.length;
  }

  /** 逐字前缀匹配：返回「从头开始」=80 或「从中间开始」=66，不匹配返回 0 */
  function sequenceScore(chars, kw) {
    for (var start = 0; start < chars.length; start++) {
      if (chars[start].py && consume(chars, start, kw)) {
        return start === 0 ? 80 : 66;
      }
    }
    return 0;
  }

  /**
   * 关键字是否从「某个字的拼音开头」开始匹配（保护性兜底规则）
   * 例：'yuxin' 在 'wangyuxin' 里从 'yu' 这个字的开头开始 → true
   *     'gy' 在 'wangyuxin' 里横跨了 'wa-ng-y-uxin' → false（避免乱命中）
   */
  function startsAtSyllable(chars, kw, full) {
    var pos = 0;
    for (var i = 0; i < chars.length; i++) {
      if (!chars[i].py) continue;
      if (pos > 0 && full.substr(pos, kw.length) === kw) return true;
      pos += chars[i].py.length;
    }
    return false;
  }

  /**
   * 给「一个字段」打分（0 = 不匹配）
   * 分数越高越像用户想找的，用于搜索结果排序
   */
  function matchScore(text, keyword) {
    var kw = toLower(keyword).trim();
    if (!kw) return 0;
    var raw = String(text == null ? '' : text);
    if (!raw) return 0;

    var low = toLower(raw);

    // ① 原文匹配（中文直接输入 / 学号 / 电话）
    if (low === kw) return 100;
    if (low.indexOf(kw) === 0) return 92;
    if (low.indexOf(kw) > 0) return 84;

    if (!enabled) return 0;

    // ② 拼音匹配
    var c = convert(raw);
    if (!c.full) return 0;
    if (c.full === kw) return 95;
    if (c.full.indexOf(kw) === 0) return 88;

    var seq = sequenceScore(c.chars, kw);
    if (seq) return seq;

    // ③ 兜底：从某个字的拼音开头开始的整段匹配（比 ② 宽松，但比「任意子串」严谨）
    if (startsAtSyllable(c.chars, kw, c.full)) return 50;

    return 0;
  }

  /**
   * 给「一条记录」打分：多个字段取最高分
   * @param {Array} fields 参与匹配的字符串数组，如 [姓名, 班级, 学号]
   */
  function bestScore(fields, keyword) {
    var best = 0;
    for (var i = 0; i < fields.length; i++) {
      var s = matchScore(fields[i], keyword);
      if (s > best) best = s;
      if (best >= 100) break;
    }
    return best;
  }

  /**
   * 搜索打分：空格分隔的多个关键字都要命中（AND），分数累加
   * @param {Array} fields
   * @param {String} keyword 例如 '张 高一' 或 'zxm g1'
   * @return {Number} 0 表示不匹配
   */
  function searchScore(fields, keyword) {
    var kw = String(keyword == null ? '' : keyword).trim();
    if (!kw) return 0;
    var tokens = kw.split(/\s+/);
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var s = bestScore(fields, tokens[i]);
      if (!s) return 0;          // 有一个关键字没命中就不算命中
      total += s;
    }
    return total;
  }

  return {
    /** 'full' = 拼音可用；'plain' = 不支持拼音，仅原文匹配 */
    get mode() { return enabled ? 'full' : 'plain'; },
    get enabled() { return enabled; },

    /** '张小明' → 'zhangxiaoming'（不支持时返回 ''） */
    full: function (text) { return enabled ? convert(text).full : ''; },
    /** '张小明' → 'zxm'（不支持时返回 ''） */
    initials: function (text) { return enabled ? convert(text).initials : ''; },
    /** 逐字信息，调试/展示用 */
    parse: convert,

    matchScore: matchScore,
    bestScore: bestScore,
    searchScore: searchScore,

    /** 清空缓存（一般用不到） */
    clearCache: function () { cache = {}; cacheCount = 0; }
  };
});