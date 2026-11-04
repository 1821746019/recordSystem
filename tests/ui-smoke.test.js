/*!
 * tests/ui-smoke.test.js —— 界面层冒烟测试（纯 Node，无依赖）
 * 运行：node tests/ui-smoke.test.js
 *
 * 用一个会「记账」的 DOM 桩把界面脚本加载起来，检查：
 *  1. 各页面能正常渲染、不出现 undefined/NaN
 *  2. 关键内容正确（张数、金额、批次、单价…）
 *  3. 用户输入被正确转义（防 XSS）
 *  4. ★ 点「＋/−」或快捷数字时，张数输入框会同步更新（回归：曾出现输入框不变）
 *  5. ★ 页面重绘不会累积事件监听（回归：曾出现点一次弹出 N 个弹窗）
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..') + path.sep;
var UI = ROOT + 'js' + path.sep + 'ui' + path.sep;

/* ---------------------- 可记账的 DOM 桩 ---------------------- */

/** 每个元素都记录：挂了哪些监听、querySelector 缓存（模拟真实 DOM 的稳定性） */
function smartEl(tag) {
  var el = {
    tagName: (tag || 'div').toUpperCase(),
    className: '', innerHTML: '', textContent: '', value: '', hidden: false,
    dataset: {}, style: {}, files: [], children: [], listeners: {}, _q: {},
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
    addEventListener: function (type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener: function (type, fn) {
      var arr = el.listeners[type] || [];
      var i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    appendChild: function (c) { el.children.push(c); return c; },
    removeChild: function () {},
    insertAdjacentHTML: function () {},
    click: function () {},
    // 同一个选择器多次查询返回同一个元素（和浏览器一致，这才能验证「写回输入框」）
    querySelector: function (sel) {
      if (!el._q[sel]) el._q[sel] = smartEl('div');
      return el._q[sel];
    },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    contains: function () { return true; },
    focus: function () {}, setSelectionRange: function () {}
  };
  return el;
}

var byId = {};
global.document = {
  readyState: 'complete',
  body: smartEl('body'),
  visibilityState: 'visible',
  activeElement: null,
  getElementById: function (id) {
    if (!byId[id]) byId[id] = smartEl('div');
    return byId[id];
  },
  createElement: function (tag) { return smartEl(tag); },
  addEventListener: function () {}, removeEventListener: function () {},
  querySelector: function () { return smartEl('div'); },
  querySelectorAll: function () { return []; }
};
global.window = global;
try { global.navigator = { userAgent: 'node' }; } catch (e) { /* 已有 */ }
global.Blob = function () {};
global.URL = { createObjectURL: function () { return ''; }, revokeObjectURL: function () {} };
global.localStorage = {
  _d: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem: function (k, v) { this._d[k] = String(v); },
  removeItem: function (k) { delete this._d[k]; }
};

/* ---------------------- 加载代码 ---------------------- */

var U = require(ROOT + 'js/core/utils.js');
var Pricing = require(ROOT + 'js/core/pricing.js');
var Storage = require(ROOT + 'js/core/storage.js');
var Store = require(ROOT + 'js/core/store.js');
var P = global.PrintSystem;

['dom.js', 'actions.js', 'quick.js', 'records.js', 'students.js', 'stats.js', 'settings.js', 'app.js']
  .forEach(function (f) {
    (0, eval)(fs.readFileSync(UI + f, 'utf8'));
  });

/* ---------------------- 测试框架 ---------------------- */

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; console.log('  \u274c ' + name + (extra !== undefined ? '  => ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

var VIEWS = ['Quick', 'Records', 'Students', 'Stats', 'Settings'];

var store = Store.create({ adapter: Storage.createMemoryAdapter() });
var appStub = {
  store: store, state: {},
  refresh: function () {}, go: function () {}, toast: function () {},
  confirm: function () { return Promise.resolve(false); }
};

/** 与 app.js 的 state 结构保持一致 */
function freshState() {
  return {
    quick: {
      selectedIds: [], search: '', autoMap: {}, excluded: [], sheets: 0,
      date: U.todayString(), time: '10:00', note: '',
      lastBatchId: '', lastBatchCount: 0, lastBatchTotalFen: 0
    },
    records: { keyword: '', from: '', to: '', range: 'all', status: 'all', selected: [] },
    students: { keyword: '', sort: 'unpaid', expanded: {} },
    stats: {}
  };
}
function makeCtx(state) {
  return { app: appStub, store: store, U: U, DOM: P.UI.DOM, state: state || freshState() };
}
function safeRender(name, state) {
  try { return { html: P.UI[name].render(makeCtx(state)), err: null }; }
  catch (e) { return { html: '', err: e }; }
}
function checkNoLeak(label, html) {
  ok(label + ' 没有 undefined / NaN 泄漏',
    html.indexOf('undefined') < 0 && html.indexOf('NaN') < 0);
}
/** 模拟一次点击：只有匹配 selector 的处理器会命中 */
function fireClick(root, selector, btn, type) {
  var fake = {
    target: {
      closest: function (sel) { return sel === selector ? btn : null; }
    },
    stopPropagation: function () {},
    preventDefault: function () {}
  };
  (root.listeners[type || 'click'] || []).forEach(function (fn) {
    try { fn(fake); } catch (e) { /* 桩环境忽略 */ }
  });
}

/* ---------------------- 用例 ---------------------- */

section('空数据时各页面渲染');
VIEWS.forEach(function (name) {
  var r = safeRender(name);
  ok(name + ' 渲染不报错', !r.err, r.err && r.err.message);
  ok(name + ' 有内容（' + r.html.length + ' 字符）', r.html.length > 100);
  checkNoLeak(name, r.html);
});

section('载入示例数据后渲染');
store.seedDemoData();
VIEWS.forEach(function (name) {
  var r = safeRender(name);
  ok(name + ' 渲染不报错', !r.err, r.err && r.err.message);
  checkNoLeak(name, r.html);
});

section('记账页：只填张数（不再区分单/双面）');
var h = safeRender('Quick').html;
ok('有学生搜索框', h.indexOf('q-search') > 0);
ok('搜索框提示支持逗号分隔批量选中', h.indexOf('\u9017\u53f7') > 0 || h.indexOf('zzh,zqy') > 0, h);
ok('张数快捷里有 0.5 张', h.indexOf('data-value="0.5"') > 0);
ok('张数区标题正确', h.indexOf('每人打印了多少张') > 0);
ok('只有「张数」一个输入框', h.indexOf('id="q-sheets"') > 0);
ok('不再出现单面输入框', h.indexOf('q-singleSheets') < 0 && h.indexOf('单面') < 0);
ok('不再出现双面输入框', h.indexOf('q-doubleSheets') < 0 && h.indexOf('双面') < 0);
ok('不再出现页数', h.indexOf('页') < 0);
ok('说明金额 = 张数 × 单价', h.indexOf('金额 = 张数 × 单价') > 0);
ok('未选学生时合计为 ¥0.00', h.indexOf('\u00a50.00') > 0);
ok('有保存按钮', h.indexOf('保存记录') > 0);
ok('有保存并清空按钮', h.indexOf('保存并清空') > 0);
ok('未保存时不显示撤销条', h.indexOf('undo-bar') < 0);

var st2 = freshState();
var all = store.listStudents('');
st2.quick.selectedIds = [all[0].id, all[1].id];
st2.quick.sheets = 5;
h = P.UI.Quick.render(makeCtx(st2));
ok('已选 2 人时显示徽标「已选 2 人」', h.indexOf('已选 2 人') > 0);
ok('显示每人 1.50 元', h.indexOf('每人 \u00a51.50') > 0);
ok('合计显示 ¥3.00（2 人 × 1.50）', h.indexOf('\u00a53.00') > 0, h.match(/\u00a5[0-9.]+/g));
ok('显示合计张数（共 10 张）', h.indexOf('共 10 张') > 0);
ok('按钮显示人数「保存记录（2 人）」', h.indexOf('保存记录（2 人）') > 0);
ok('已选学生显示为可移除标签', h.indexOf('pick-chip') > 0 && h.indexOf('data-action="unpick"') > 0);

st2.quick.lastBatchId = 'bat_x';
st2.quick.lastBatchCount = 3;
st2.quick.lastBatchTotalFen = 450;
h = P.UI.Quick.render(makeCtx(st2));
ok('保存后显示「撤销这一批」', h.indexOf('撤销这一批') > 0 && h.indexOf('undo-bar') > 0);
ok('撤销条显示上一批人数与金额', h.indexOf('3 人') > 0 && h.indexOf('\u00a54.50') > 0);

section('★ 回归：点「＋」号时张数输入框必须跟着变');
var qState = freshState();
qState.quick.selectedIds = [all[0].id];
var qContainer = smartEl('main');
var qRoot = P.UI.mountView(P.UI.Quick, qContainer, makeCtx(qState), '');
var sheetsInput = qRoot.querySelector('#q-sheets');

ok('挂载后输入框初值为 0', Number(sheetsInput.value) === 0, sheetsInput.value);

// 点一次「＋」（步进现在是 0.5 张）
  fireClick(qRoot, '[data-action="step"]', { dataset: { field: 'sheets', delta: '0.5' } });
  ok('点 1 次＋：state 张数 = 0.5', qState.quick.sheets === 0.5, qState.quick.sheets);
  ok('点 1 次＋：输入框显示 0.5（这就是之前漏掉的一步）',
    Number(sheetsInput.value) === 0.5, sheetsInput.value);

  fireClick(qRoot, '[data-action="step"]', { dataset: { field: 'sheets', delta: '0.5' } });
  fireClick(qRoot, '[data-action="step"]', { dataset: { field: 'sheets', delta: '0.5' } });
  ok('再点 2 次＋：输入框显示 1.5', Number(sheetsInput.value) === 1.5, sheetsInput.value);
  ok('金额同步为 ¥0.45（1 人 × 1.5 张）',
    qRoot.querySelector('#q-amount').textContent === '\u00a50.45',
    qRoot.querySelector('#q-amount').textContent);

  // 点「−」
  fireClick(qRoot, '[data-action="step"]', { dataset: { field: 'sheets', delta: '-0.5' } });
  ok('点－：输入框回到 1', Number(sheetsInput.value) === 1, sheetsInput.value);

  // ★ 半张快捷（0.5 张 = 0.15 元）
  fireClick(qRoot, '[data-action="chip"]', { dataset: { field: 'sheets', value: '0.5' } });
  ok('★ 点「0.5」：张数变成 0.5', qState.quick.sheets === 0.5, qState.quick.sheets);
  ok('★ 半张金额 ¥0.15（0.5 × 0.30）',
    qRoot.querySelector('#q-amount').textContent === '\u00a50.15',
    qRoot.querySelector('#q-amount').textContent);
  ok('明细文案显示 0.5 张', qRoot.querySelector('#q-detail').textContent.indexOf('0.5 张') === 0,
    qRoot.querySelector('#q-detail').textContent);

  // 点快捷数字
  fireClick(qRoot, '[data-action="chip"]', { dataset: { field: 'sheets', value: '20' } });
  ok('点快捷数字 20：输入框显示 20', Number(sheetsInput.value) === 20, sheetsInput.value);
  ok('金额同步为 ¥6.00', qRoot.querySelector('#q-amount').textContent === '\u00a56.00',
    qRoot.querySelector('#q-amount').textContent);

  // 点清零
  fireClick(qRoot, '[data-action="chip"]', { dataset: { field: 'sheets', value: '0' } });
  ok('点清零：输入框显示 0', Number(sheetsInput.value) === 0, sheetsInput.value);
  ok('金额归零', qRoot.querySelector('#q-amount').textContent === '\u00a50.00');

  // 张数不能为负
  fireClick(qRoot, '[data-action="step"]', { dataset: { field: 'sheets', delta: '-0.5' } });
  ok('张数不会变成负数', qState.quick.sheets === 0 && Number(sheetsInput.value) === 0);

  // 手输小数：只接受 0.5 粒度
  var ci = qRoot.querySelector('#q-sheets');
  ci.value = '2.6';
  fireClick(qRoot, '.counter-input', { dataset: { field: 'sheets' }, value: '2.6' }, 'input');
  ok('手输 2.6 → 规范成 2.5（半张粒度）', qState.quick.sheets === 2.5, qState.quick.sheets);

section('★ 回归：保存按钮的人数必须跟着「当前选择」实时变');
(function () {
  var bState = freshState();
  var all = store.listStudents('');
  // 预置 2 个已选，避免依赖搜索（搜索现在会自动勾选，会影响这组断言的前置条件）
  bState.quick.selectedIds = [all[0].id, all[1].id];
  var bRoot = P.UI.mountView(P.UI.Quick, smartEl('main'), makeCtx(bState), '');
  var q = function (sel) { return bRoot.querySelector(sel); };
  var saveText = function () { return q('[data-action="save"]').textContent; };
  var badgeText = function () { return (q('.count-badge') || {}).textContent; };

  ok('已选 2 人时按钮就是「保存记录（2 人）」', saveText() === '\u4fdd\u5b58\u8bb0\u5f55\uff082 \u4eba\uff09', saveText());
  ok('徽标显示「已选 2 人」', badgeText() === '\u5df2\u9009 2 \u4eba', badgeText());

  // 取消 1 人 —— 这里就是之前出 bug 的地方（按钮文案不跟着变）
  fireClick(bRoot, '[data-action="unpick"]', { dataset: { id: all[1].id } });
  ok('★ 取消 1 人后按钮立刻退回「保存记录」', saveText() === '\u4fdd\u5b58\u8bb0\u5f55', saveText());
  ok('★ 徽标同步为「已选 1 人」', badgeText() === '\u5df2\u9009 1 \u4eba', badgeText());

  // 再取消剩下 1 人
  fireClick(bRoot, '[data-action="unpick"]', { dataset: { id: all[0].id } });
  ok('全取消后按钮仍是「保存记录」', saveText() === '\u4fdd\u5b58\u8bb0\u5f55', saveText());
  ok('全取消后徽标被移除（文案清空）', badgeText() === '', badgeText());
  ok('取消过的人被记进 excluded（自动勾选不会再勾回来）',
    bState.quick.excluded.length === 2, bState.quick.excluded.length);

  // 手动勾回来 → 解除排除
  fireClick(bRoot, '[data-action="unpick"]', { dataset: { id: all[0].id } });   // 勾回来
  ok('手动勾回后按钮显示「保存记录」并解除排除', bState.quick.excluded.length === 1,
    bState.quick.excluded.length);
})();

section('★ 保存按钮在新会话里也不串人数（重新挂载后跟着 state 走）');
(function () {
  var st = freshState();
  var root = P.UI.mountView(P.UI.Quick, smartEl('main'), makeCtx(st), '');
  var saveText = function () { return root.querySelector('[data-action="save"]').textContent; };
  ok('新会话未选人 →「保存记录」', saveText() === '\u4fdd\u5b58\u8bb0\u5f55', saveText());
})();

section('★ 候选列表的工具条（全选 / 清空已选）：位置与显隐');
(function () {
  var tState = freshState();
  var tRoot = P.UI.mountView(P.UI.Quick, smartEl('main'), makeCtx(tState), '');
  var q = function (sel) { return tRoot.querySelector(sel); };
  var listEl = q('#q-list');
  var listHtml = function () { return listEl.innerHTML; };
  function search(kw) {
    var inp = q('#q-search');
    inp.value = kw;
    (inp.listeners.input || []).forEach(function (fn) { try { fn({ target: inp }); } catch (e) {} });
  }

  // ① 多个结果、且没人被选中：工具条应出现在顶部（滚动区之前），带「全选 N 人」
  //   注意：这里用 1 个字的短词「高」——它不会触发自动勾选（分隔词需 ≥2 字），
  //        这样才能验证「未选人时」的状态。
  search('\u9ad8');
  var html = listHtml();
  ok('搜索结果多于 1 人时显示工具条', html.indexOf('combo-tools') > 0);
  ok('★ 工具条排在滚动区之前（因此固定在顶部，不用滚列表）',
    html.indexOf('combo-tools') < html.indexOf('combo-items'),
    html.indexOf('combo-tools') + ' vs ' + html.indexOf('combo-items'));
  ok('★ 学生行都在滚动区内部（在 combo-items 之后）',
    html.indexOf('data-action="toggle-student"') > html.indexOf('combo-items'));
  ok('工具条里有「全选这 N 人」（N=当前搜索结果数）',
    html.indexOf('\u5168\u9009\u8fd9 ' + store.listStudents('\u9ad8').length + ' \u4eba') > 0,
    store.listStudents('\u9ad8').length);
  ok('未选人时不显示「清空已选」', html.indexOf('clear-picked') < 0);
  ok('1 个字的短词不会自动勾选（避免输一个字母就选一大片）',
    tState.quick.selectedIds.length === 0, tState.quick.selectedIds.length);

  // ② 只有 1 个结果且没选人：工具条没有意义，应隐藏
  search('\u5f20');
  html = listHtml();
  ok('只有 1 个结果且未选人时隐藏工具条（避免占地方）',
    html.indexOf('combo-tools') < 0 && html.indexOf('data-action="toggle-student"') > 0);

  // ③ 选中这 1 个人之后：工具条应出现（此时只留「清空已选」）
  fireClick(listEl, '[data-action="toggle-student"]', { dataset: { id: store.listStudents('\u5f20')[0].id } });
  html = listHtml();
  ok('已选 1 人时工具条重新出现', html.indexOf('combo-tools') > 0);
  ok('★「清空已选」带上了数量：清空已选（1）', html.indexOf('\u6e05\u7a7a\u5df2\u9009\uff081\uff09') > 0, html);
  ok('只有 1 个结果时不再显示「全选这 1 人」', html.indexOf('select-all-results') < 0);

  // ④ 再搜出多人：两个按钮都在
  search('\u9ad8');
  html = listHtml();
  ok('多人结果 + 已选 1 人：全选与清空都在工具条里',
    html.indexOf('select-all-results') > 0 && html.indexOf('clear-picked') > 0);

  // ⑤ 清空后回到「未选人」状态
  fireClick(listEl, '[data-action="clear-picked"]', { dataset: {} });
  ok('清空后已选数归零', tState.quick.selectedIds.length === 0);
  ok('清空后搜索框也被清空（下次重新开始）', tState.quick.search === '', tState.quick.search);
})();

section('样式约束：显示 / 隐藏不能互相打架（防 [hidden] 被 display 覆盖）');
(function () {
  var cssPath = require('path').join(__dirname, '..', 'css', 'style.css');
  var css = require('fs').readFileSync(cssPath, 'utf8');

  ok('候选列表用了 flex 布局（工具条固定在顶部的实现方式）',
    /\.combo-list\s*\{[^}]*display:\s*flex/.test(css));
  ok('★ 样式表里有强制 [hidden] 生效的兜底规则',
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css));
  ok('内层学生列表确实设了 overflow-y:auto（可滚动）',
    /\.combo-items\s*\{[^}]*overflow-y:\s*auto/.test(css));
  ok('外层候选列表设了 overflow:hidden（负责裁剪与圆角）',
    /\.combo-list\s*\{[^}]*overflow:\s*hidden/.test(css));
})();

section('★ 分隔符批量自动勾选（zzh,zqy → 取消 → 追加 zjb）');
(function () {
  // 用和需求里一模一样的名字，验证用户描述的完整场景
  var ts = Store.create({ adapter: Storage.createMemoryAdapter() });
  ts.addStudent({ name: '郑卓涵', className: '高三(1)班' });
  ts.addStudent({ name: '郑卓欢', className: '高三(1)班' });
  ts.addStudent({ name: '郑琪烨', className: '高三(1)班' });
  ts.addStudent({ name: '郑佳堡', className: '高三(1)班' });

  var st = freshState();
  var root = P.UI.mountView(P.UI.Quick, smartEl('main'), {
    app: appStub, store: ts, U: U, DOM: P.UI.DOM, state: st
  }, '');
  var inp = root.querySelector('#q-search');

  function type(text) {
    inp.value = text;
    (inp.listeners.input || []).forEach(function (fn) { try { fn({ target: inp }); } catch (e) {} });
  }
  function names() {
    return st.quick.selectedIds.map(function (id) { return ts.getStudent(id).name; })
      .sort().join(',');
  }

  // ① 输入两个拼音首字母
  type('zzh,zqy');
  ok('★ 输入 zzh,zqy → 自动选中 3 人（郑卓涵/郑卓欢/郑琪烨）',
    st.quick.selectedIds.length === 3 &&
    names().indexOf('\u90d1\u5353\u6db5') >= 0 &&
    names().indexOf('\u90d1\u5353\u6b22') >= 0 &&
    names().indexOf('\u90d1\u742a\u70e8') >= 0, names());

  // ② 手动取消郑卓涵
  var zh = ts.findStudentByName('\u90d1\u5353\u6db5');
  fireClick(root, '[data-action="unpick"]', { dataset: { id: zh.id } });
  ok('取消后郑卓涵不再选中', names().indexOf('\u90d1\u5353\u6db5') < 0, names());
  ok('取消的人被记进 excluded', st.quick.excluded.indexOf(zh.id) >= 0);

  // ③ 在输入框追加 zjb —— 这是需求里的关键场景
  type('zzh,zqy,zjb');
  ok('★ 追加 zjb → 郑佳堡被自动勾选', names().indexOf('\u90d1\u4f73\u5821') >= 0, names());
  ok('★ 前面取消的郑卓涵保持未勾选', names().indexOf('\u90d1\u5353\u6db5') < 0, names());
  ok('★ 其余人保持不变（郑卓欢/郑琪烨仍在）',
    names().indexOf('\u90d1\u5353\u6b22') >= 0 && names().indexOf('\u90d1\u742a\u70e8') >= 0, names());
  ok('★ 此时共选中 3 人（郑卓欢/郑琪烨/郑佳堡）',
    st.quick.selectedIds.length === 3, names());

  // ④ 删掉 zjb → 郑佳堡应被自动取消
  type('zzh,zqy');
  ok('删掉 zjb 后郑佳堡自动取消', names().indexOf('\u90d1\u4f73\u5821') < 0, names());

  // ⑤ 再删掉 zqy → 郑琪烨自动取消，只剩郑卓欢（郑卓涵被排除）
  type('zzh');
  ok('删掉 zqy 后郑琪烨自动取消', names().indexOf('\u90d1\u742a\u70e8') < 0, names());
  ok('只剩郑卓欢（郑卓涵仍被排除）', names() === '\u90d1\u5353\u6b22', names());

  // ⑥ 清空搜索框 = 这一轮结束，排除记录重置
  type('');
  ok('清空搜索后排除记录被重置', st.quick.excluded.length === 0, st.quick.excluded.length);
  type('zzh');
  ok('重新输入 zzh → 郑卓涵被重新勾上', names().indexOf('\u90d1\u5353\u6db5') >= 0, names());

  // ⑦ 简写输入再补全（zz → zzh）时，多选出来的人要退掉
  type('');
  st.quick.selectedIds = []; st.quick.autoMap = {}; st.quick.excluded = [];
  type('zj');
  var afterShort = st.quick.selectedIds.length;
  type('zjb');
  ok('★ 输入 zj 会先选中郑佳堡，改成 zjb 后仍是这 1 人（不会越选越多）',
    afterShort === 1 && st.quick.selectedIds.length === 1,
    afterShort + ' -> ' + st.quick.selectedIds.length);
})();

section('★ 拼音搜索（界面层真实交互）');
ok('记账页搜索框提示支持拼音', h.indexOf('拼音') > 0 || h.indexOf('首字母') > 0);
ok('记账页提示支持逗号批量勾选', P.UI.Quick.render(makeCtx()).indexOf('zzh,zqy') > 0);

var srState = freshState();
var srRoot = P.UI.mountView(P.UI.Quick, smartEl('main'), makeCtx(srState), '');
var searchInput = srRoot.querySelector('#q-search');
searchInput.value = 'zxm';
(searchInput.listeners.input || []).forEach(function (fn) {
  try { fn({ target: searchInput }); } catch (e) { /* 桩环境忽略 */ }
});
var listHtml = srRoot.querySelector('#q-list').innerHTML;
ok('在搜索框输入 zxm → 候选列表出现张小明', listHtml.indexOf('张小明') > 0);
ok('在搜索框输入 zxm → 候选列表没有李思远', listHtml.indexOf('李思远') < 0);
ok('候选列表里给出了「新建学生」入口', listHtml.indexOf('data-action="create-student"') > 0);

searchInput.value = '高';
(searchInput.listeners.input || []).forEach(function (fn) {
  try { fn({ target: searchInput }); } catch (e) { /* 忽略 */ }
});
listHtml = srRoot.querySelector('#q-list').innerHTML;
ok('输入班级首字母/汉字也能筛出多人', listHtml.split('data-action="toggle-student"').length - 1 >= 2,
  listHtml.split('data-action="toggle-student"').length - 1);

// 学生页：关键字框输入拼音后，只渲染匹配的人
var stuState = freshState();
stuState.students.keyword = 'zxm';
var stuHtml = P.UI.Students.render(makeCtx(stuState));
ok('学生页搜 zxm → 只显示张小明', stuHtml.indexOf('张小明') > 0 && stuHtml.indexOf('李思远') < 0);
stuState.students.keyword = 'zhangxiaoming';
ok('学生页搜全拼 → 也能命中', P.UI.Students.render(makeCtx(stuState)).indexOf('张小明') > 0);
ok('学生页搜不到时给出空状态', P.UI.Students.render(makeCtx(
  Object.assign(freshState(), { students: { keyword: 'qqqq', sort: 'unpaid', expanded: {} } })
)).indexOf('还没有学生') > 0);

// 记录页：关键字框输入拼音后，只渲染该学生的记录
var recState = freshState();
recState.records.keyword = 'zxm';
var recHtml = P.UI.Records.render(makeCtx(recState));
ok('记录页搜 zxm → 命中的记录里是张小明（不出现李思远）',
  recHtml.indexOf('张小明') > 0 && recHtml.indexOf('李思远') < 0);
ok('记录页搜索框提示支持拼音', recHtml.indexOf('拼音') > 0);

section('记录页：张数与批次标记');
h = safeRender('Records').html;
ok('记录页显示金额符号 ¥', h.indexOf('\u00a5') > 0);
ok('记录页显示张数与单价', h.indexOf(' 张</span>') > 0 && h.indexOf(' 元/张</span>') > 0);
ok('记录页不再出现单/双面与页数', h.indexOf('单面') < 0 && h.indexOf('双面') < 0 && h.indexOf('页') < 0);
ok('记录页有结清状态标记', h.indexOf('未结清') > 0);
ok('记录页有导出按钮', h.indexOf('导出 CSV') > 0);
ok('记录页有统计条', h.indexOf('filter-summary') > 0);
ok('示例的批量记录带「同批」标记', h.indexOf('tag-batch') > 0 && h.indexOf('同批') > 0);
ok('页面里没有注入的 script 标签', h.indexOf('<script') < 0);

section('学生页');
h = safeRender('Students').html;
ok('显示示例学生', h.indexOf('张小明') > 0);
ok('有未结清/已结清标记', h.indexOf('未结清') > 0 || h.indexOf('已结清') > 0);
ok('有结清按钮', h.indexOf('结清全部') > 0);
ok('有「导入名单」按钮', h.indexOf('data-action="import-csv"') > 0);
ok('有「导出名单」按钮', h.indexOf('data-action="export-csv"') > 0);
ok('学生页不再出现页数', h.indexOf('页') < 0);

section('统计页：批次汇总与人均张数');
h = safeRender('Stats').html;
ok('有总览', h.indexOf('应收总额') > 0);
ok('有打印张数', h.indexOf('打印张数') > 0);
ok('有「人均张数」（替代已取消的总页数）', h.indexOf('人均张数') > 0 && h.indexOf('总页数') < 0);
ok('有月度汇总表', h.indexOf('月度汇总') > 0 && h.indexOf('data-table') > 0);
ok('月度表里没有页数列', h.indexOf('<th>页数</th>') < 0);
ok('有学生排行', h.indexOf('学生消费排行') > 0);
ok('有「批量记账批次」区块', h.indexOf('批量记账批次') > 0);
ok('批次显示每人张数', h.indexOf('每人 5 张') > 0, h.match(/每人 [0-9]+ 张/g));
ok('批次有撤销按钮', h.indexOf('data-action="del-batch"') > 0);
ok('有收款记录区', h.indexOf('收款记录') > 0);
ok('有批次汇总 CSV 导出', h.indexOf('exp-batches') > 0);

section('设置页：统一单价');
h = safeRender('Settings').html;
ok('显示当前单价 0.30', h.indexOf('0.30') > 0);
ok('字段名为「打印单价」', h.indexOf('打印单价') > 0);
ok('说明金额 = 张数 × 单价', h.indexOf('金额 = 张数 × 单价') > 0);
ok('不再出现「单面单价」字段', h.indexOf('单面单价') < 0);
ok('有备份/恢复', h.indexOf('备份为 JSON') > 0 && h.indexOf('从 JSON 恢复') > 0);

section('用户输入转义（防 XSS / 破坏排版）');
var weird = store.addStudent({ name: '<img src=x onerror=alert(1)>', className: '" onmouseover="x' });
store.addRecord({ studentId: weird.id, sheets: 1, note: '</div><script>bad()</script>' });
var ws = freshState();
ws.quick.selectedIds = [weird.id];
h = P.UI.Records.render(makeCtx(ws));
ok('记录页学生姓名被转义', h.indexOf('<img src=x') < 0 && h.indexOf('&lt;img') > 0);
ok('记录页备注被转义', h.indexOf('<script>bad') < 0);
h = P.UI.Quick.render(makeCtx(ws));
ok('记账页选中标签被转义', h.indexOf('<img src=x') < 0 && h.indexOf('&lt;img') > 0);
h = P.UI.Stats.render(makeCtx(ws));
ok('统计页学生名被转义', h.indexOf('<img src=x') < 0);

section('页面重绘不会累积事件监听（防「点一次编辑弹出 N 个弹窗」）');
ok('mountView 已导出', typeof P.UI.mountView === 'function');

var container = smartEl('main');
var roots = [];
for (var i = 0; i < 5; i++) {
  roots.push(P.UI.mountView(P.UI.Students, container, makeCtx(), '<section>概览</section>'));
}
ok('每次重绘都返回全新的挂载容器',
  roots[0] !== roots[1] && roots[1] !== roots[2] && roots[4] !== roots[0]);
ok('常驻容器 #view 上没有被挂任何监听（这是 bug 的根源）',
  Object.keys(container.listeners).length === 0, Object.keys(container.listeners));

var clickCounts = roots.map(function (r) { return (r.listeners.click || []).length; });
ok('每次挂载的点击监听数一致，不随重绘增长',
  clickCounts.every(function (n) { return n === clickCounts[0]; }), clickCounts.join(','));
ok('挂载容器上确实绑定了本页的事件（' + clickCounts[0] + ' 个）', clickCounts[0] > 0);

var badEl = smartEl('main');
P.UI.DOM.on(badEl, 'click', '[data-action="edit"]', function () {});
P.UI.DOM.on(badEl, 'click', '[data-action="edit"]', function () {});
ok('（反例）同一元素挂两次监听确实会翻倍 → 旧写法点一次会弹 2 个弹窗',
  badEl.listeners.click.length === 2, badEl.listeners.click.length);

section('★ 回归：连续重绘后点一次「编辑」只弹 1 个弹窗');
var c2 = smartEl('main');
var liveRoot = null;
for (var j = 0; j < 3; j++) {
  liveRoot = P.UI.mountView(P.UI.Students, c2, makeCtx(), '');
}
var modalCount = 0;
var origOpenModal = P.UI.DOM.openModal;
P.UI.DOM.openModal = function () { modalCount++; return { close: function () {} }; };

var fakeCard = { dataset: { id: 'x' } };
var fakeBtn = {
  dataset: { action: 'edit' },
  closest: function (sel) {
    if (sel === '[data-action="edit"]') return fakeBtn;
    if (sel === '.student-card') return fakeCard;
    return null;
  }
};
fireClick(liveRoot, '[data-action="edit"]', fakeBtn);
P.UI.DOM.openModal = origOpenModal;

ok('点一次「编辑」只弹出 1 个弹窗', modalCount === 1, modalCount + ' 个');
ok('最新容器上的处理器数量与单次渲染一致（没有残留的重复绑定）',
  (liveRoot.listeners.click || []).length === clickCounts[0],
  (liveRoot.listeners.click || []).length + ' vs ' + clickCounts[0]);

section('各页面 render 在空数据下也正常');
var emptyStore = Store.create({ adapter: Storage.createMemoryAdapter() });
VIEWS.forEach(function (name) {
  var ctx = { app: appStub, store: emptyStore, U: U, DOM: P.UI.DOM, state: freshState() };
  var err = null, html = '';
  try { html = P.UI[name].render(ctx); } catch (e) { err = e; }
  ok(name + ' render 正常', !err, err && err.message);
  if (html) checkNoLeak(name, html);
});

/* ---------------------- 汇总 ---------------------- */

console.log('\n========================================');
console.log('界面层冒烟测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exitCode = 1;