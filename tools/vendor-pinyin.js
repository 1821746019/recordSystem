#!/usr/bin/env node
/*!
 * tools/vendor-pinyin.js —— 把 tiny-pinyin 打包成「单文件」放进 js/vendor/
 * ---------------------------------------------------------------
 * 为什么不用 npm 依赖？
 *   本项目要求：双击 index.html 就能跑、完全离线、之后还要能直接 require 进微信小程序。
 *   所以第三方库必须内联成一个不依赖构建的单文件（vendor），并且带上原许可。
 *
 * 用法：
 *   node tools/vendor-pinyin.js <tiny-pinyin 包目录>
 *   例： npm i --no-save tiny-pinyin && node tools/vendor-pinyin.js node_modules/tiny-pinyin
 *
 * 生成物：
 *   js/vendor/tiny-pinyin.js         单文件版本（UMD：浏览器挂 global，小程序/Node 走 module.exports）
 *   js/vendor/tiny-pinyin.LICENSE    原库 MIT 许可原文
 */
'use strict';

var fs = require('fs');
var path = require('path');

var SRC = process.argv[2] || path.join(__dirname, '..', 'node_modules', 'tiny-pinyin');
var ROOT = path.join(__dirname, '..');
var OUT_JS = path.join(ROOT, 'js', 'vendor', 'tiny-pinyin.js');
var OUT_LICENSE = path.join(ROOT, 'js', 'vendor', 'tiny-pinyin.LICENSE');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}
function indent(src) {
  return src.split('\n').map(function (l) { return l ? '  ' + l : l; }).join('\n');
}

var pkg = JSON.parse(read('package.json'));
var authorName = (pkg.author && (pkg.author.name || pkg.author)) || '';
if (typeof authorName !== 'string') authorName = '';

/* 打包哪些模块（顺序无所谓，按需 require） */
var MODULES = [
  ['./dict', 'dist/dict.js'],
  ['./patchers/56l', 'dist/patchers/56l.js'],
  ['./patchers/safari', 'dist/patchers/safari.js'],
  ['./core', 'dist/core.js'],
  ['./index', 'dist/index.js']
];

var out = [];
out.push('/*!');
out.push(' * vendor/tiny-pinyin.js');
out.push(' * ★ 本文件由 tools/vendor-pinyin.js 自动生成，请不要手改（改完下次生成会被覆盖）');
out.push(' *');
out.push(' * 来源：tiny-pinyin v' + pkg.version + '  ' + (pkg.homepage || ''));
out.push(' * 作者：' + authorName + '   许可：' + (pkg.license || 'MIT'));
out.push(' * 许可原文见同目录 tiny-pinyin.LICENSE');
out.push(' *');
out.push(' * 原理：不依赖任何词库——借用运行环境自带的 ICU 中文排序（Intl.Collator）');
out.push(' *       对 ~400 个「拼音边界汉字」做二分查找，即可得出完整拼音；');
out.push(' *       另带一份姓氏多音字修正表（曾→ZENG、沈→SHEN…）。因此整个库只有十几 KB。');
out.push(' * 兼容：Chrome / Android WebView / Safari(iOS) / Node（都需要 ICU 的 zh 排序支持）');
out.push(' * 生成时间：' + new Date().toISOString());
out.push(' */');
out.push('(function (root, factory) {');
out.push('  "use strict";');
out.push('  if (typeof module !== "undefined" && module.exports) {');
out.push('    module.exports = factory();');
out.push('  } else {');
out.push('    root.PrintSystem = root.PrintSystem || {};');
out.push('    root.PrintSystem.vendorTinyPinyin = factory();');
out.push('  }');
out.push('})(typeof globalThis !== "undefined" ? globalThis : this, function () {');
out.push('  "use strict";');
out.push('');
out.push('  // —— 极简模块表：让原库里的 require("./xxx") 原样可用 ——');
out.push('  var __mods = {};');
out.push('  var __cache = {};');
out.push('  function define(id, fn) { __mods[id] = fn; }');
out.push('  function req(id) {');
out.push('    if (__cache[id]) return __cache[id].exports;');
out.push('    var m = { exports: {} };');
out.push('    __cache[id] = m;');
out.push('    __mods[id](m, m.exports, req);');
out.push('    return m.exports;');
out.push('  }');

MODULES.forEach(function (item) {
  out.push('');
  out.push('  define("' + item[0] + '", function (module, exports, require) {');
  out.push(indent(read(item[1])));
  out.push('  });');
});

out.push('');
out.push('  var pinyin = req("./index");');
out.push('');
out.push('  // 原包 browser.js 的逻辑：Safari（且非 Chrome/Android）需要打一次补丁');
out.push('  if (typeof navigator === "object" && navigator && navigator.userAgent &&');
out.push('      /safari/i.test(navigator.userAgent) && !/chrome|android/i.test(navigator.userAgent)) {');
out.push('    pinyin.patchDict(req("./patchers/safari"));');
out.push('  }');
out.push('');
out.push('  return pinyin;');
out.push('});');
out.push('');

fs.mkdirSync(path.dirname(OUT_JS), { recursive: true });
fs.writeFileSync(OUT_JS, out.join('\n'), 'utf8');
fs.copyFileSync(path.join(SRC, 'LICENSE'), OUT_LICENSE);

var size = fs.statSync(OUT_JS).size;
console.log('已生成 ' + path.relative(ROOT, OUT_JS) + '（' + (size / 1024).toFixed(1) + ' KB）');
console.log('已复制 ' + path.relative(ROOT, OUT_LICENSE));

/* 顺手自检：生成的文件必须能独立工作 */
var p = require(OUT_JS);
if (!p || typeof p.convertToPinyin !== 'function') {
  console.error('❌ 自检失败：convertToPinyin 不可用');
  process.exit(1);
}
if (p.isSupported()) {
  var sample = p.convertToPinyin('张小明', '', true);
  console.log('自检：张小明 → ' + sample);
  if (sample !== 'zhangxiaoming') {
    console.error('❌ 自检失败：拼音结果不正确');
    process.exit(1);
  }
} else {
  console.warn('⚠ 当前环境不支持 Intl.Collator 中文排序，拼音功能会自动降级');
}
console.log('✅ 完成');
