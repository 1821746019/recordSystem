/*!
 * tests/sw.test.js —— Service Worker 的运行时行为测试
 * 运行：node tests/sw.test.js
 *
 * 思路：把 sw.js 加载进 vm 沙箱，喂给它假的 `caches` / `fetch` / `self`，
 * 然后**手动派发** install / activate / fetch / message 事件。
 *
 * 关键技巧：假 `fetch` 返回一个「门闩 promise」——只有测试主动调用
 * `flushNetwork()` 才落地。这样才能真的验证 stale-while-revalidate 的语义：
 *   ① 响应必须**先**从缓存返回（不用等网络）
 *   ② 网络稍后返回时，缓存被静默改写成新版
 *   ③ 下一次访问才看到新版
 *
 * 本文件是异步的，由 tests/run.js 用 child_process 同步调用（stdio: inherit）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
var SCOPE = 'https://example.test/recordSystem/';
var ORIGIN = 'https://example.test';
var INDEX = SCOPE + 'index.html';

var SHELL_MATCH = SRC.match(/var SHELL\s*=\s*\[([\s\S]*?)\];/);
var SHELL_COUNT = SHELL_MATCH ? (SHELL_MATCH[1].match(/'/g) || []).length / 2 : 0;

// 从源码里读出真实的 CACHE_VERSION，测试夹具就不会因发版而失效
var VERSION_MATCH = SRC.match(/var CACHE_VERSION\s*=\s*'([^']+)'/);
var CACHE_NAME = 'print-record-' + (VERSION_MATCH ? VERSION_MATCH[1] : 'v1');
var OLD_CACHE = 'print-record-v0';

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; console.log('  \u274c ' + name + (extra !== undefined ? '  => ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 让一轮微任务跑完（fireFetch 之后 fetch 是在微任务里才发起的） */
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

/** 看门狗：任何 promise 悬空都会在 8 秒后明确报错，而不是静默退出 */
var watchdog = setTimeout(function () {
  console.log('\n\u274c 测试超时：有 promise 一直没落地（通常是门闩没放行）');
  process.exit(1);
}, 8000);

/* ----------------------------- 夹具 ----------------------------- */

function response(body, opts) {
  opts = opts || {};
  var r = {
    ok: opts.ok !== false,
    type: opts.type || 'basic',
    status: opts.status || 200,
    body: body,
    clone: function () { return r; }
  };
  return r;
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && input.url) return input.url;
  return String(input);
}

function keyOf(input, ignoreSearch) {
  var u = urlOf(input);
  return ignoreSearch ? u.split('?')[0] : u;
}

/** 造一个 SW 运行环境；返回句柄供测试驱动 */
function loadSW() {
  var store = {};          // 缓存内容：url -> response
  var puts = [];           // cache.put 调用记录
  var fetches = [];        // 尚未放行的网络请求
  var handlers = {};

  var claimCount = 0;
  var skipWaitingCount = 0;
  var deleted = [];
  var addAllArgs = null;

  var cache = {
    match: function (req, opts) {
      return Promise.resolve(store[keyOf(req, !!(opts && opts.ignoreSearch))]);
    },
    put: function (req, res) {
      var k = keyOf(req, false);
      store[k] = res;
      puts.push(k);
      return Promise.resolve();
    },
    addAll: function (list) { addAllArgs = list; return Promise.resolve(); },
    keys: function () { return Promise.resolve(Object.keys(store)); }
  };

  var caches = {
    open: function () { return Promise.resolve(cache); },
    keys: function () {
      return Promise.resolve([OLD_CACHE, CACHE_NAME, 'unrelated-cache']);
    },
    delete: function (k) { deleted.push(k); return Promise.resolve(true); }
  };

  function Request(url, opts) { this.url = url; this.opts = opts || {}; }

  // 门闩式 fetch：不会自己返回，必须测试调用 flushNetwork()
  function fetchFn(req, opts) {
    return new Promise(function (resolve) {
      fetches.push({ url: urlOf(req), opts: opts, resolve: resolve });
    });
  }

  var selfObj = {
    addEventListener: function (type, fn) { handlers[type] = fn; },
    registration: { scope: SCOPE },
    location: { origin: ORIGIN },
    clients: { claim: function () { claimCount++; return Promise.resolve(); } },
    skipWaiting: function () { skipWaitingCount++; }
  };

  var ctx = {
    self: selfObj,
    caches: caches,
    fetch: fetchFn,
    Request: Request,
    URL: URL,
    Promise: Promise,
    console: { warn: function () {}, log: function () {} }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'sw.js' });

  return {
    handlers: handlers,
    store: store,
    puts: puts,
    fetches: fetches,
    deleted: deleted,

    seed: function (url, body, opts) { store[url] = response(body, opts); },
    getAddAll: function () { return addAllArgs; },
    getClaimCount: function () { return claimCount; },
    getSkipWaitingCount: function () { return skipWaitingCount; },

    /** 派发一次 fetch 事件，返回可观测的 event */
    fireFetch: function (req) {
      var ev = { request: req, waits: [], responded: null };
      ev.waitUntil = function (p) { ev.waits.push(p); };
      ev.respondWith = function (p) { ev.responded = p; };
      if (handlers.fetch) handlers.fetch(ev);
      return ev;
    },

    /** 放行最早的一个网络请求 */
    flushNetwork: function (body, opts) {
      var job = fetches.shift();
      if (!job) return false;
      job.resolve(response(body, opts));
      return true;
    },

    fireLifecycle: function (type, data) {
      var ev = { waits: [], data: data };
      ev.waitUntil = function (p) { ev.waits.push(p); };
      if (handlers[type]) handlers[type](ev);
      return ev;
    }
  };
}

/* ----------------------------- 用例 ----------------------------- */

(async function () {

  section('导航请求：stale-while-revalidate');

  {
    var sw = loadSW();
    sw.seed(INDEX, 'HTML-OLD');

    var ev = sw.fireFetch({ method: 'GET', mode: 'navigate', url: SCOPE });
    ok('立刻交出了响应（不等网络）', ev.responded !== null);
    ok('注册了 waitUntil（后台任务不会被提前杀掉）', ev.waits.length === 1);

    var first = await ev.responded;
    ok('秒开的是缓存里的旧版本', first.body === 'HTML-OLD', first.body);
    ok('后台同时发起了网络请求', sw.fetches.length === 1);
    ok('请求 index.html 时带 cache: no-cache（强制校验）',
      !!(sw.fetches[0].opts && sw.fetches[0].opts.cache === 'no-cache'));
    ok('后台还没回来时，缓存仍是旧版', sw.store[INDEX].body === 'HTML-OLD');

    sw.flushNetwork('HTML-NEW');
    await Promise.all(ev.waits);
    ok('后台把新版静默写回了缓存（没有被用户感知）', sw.store[INDEX].body === 'HTML-NEW');

    var ev2 = sw.fireFetch({ method: 'GET', mode: 'navigate', url: SCOPE });
    var second = await ev2.responded;
    ok('下一次访问才看到新版（陈旧一次是 SWR 的设计）', second.body === 'HTML-NEW', second.body);
    sw.flushNetwork('HTML-NEW');
    await Promise.all(ev2.waits);
  }

  section('导航请求：没有缓存时走网络');

  {
    var sw = loadSW();
    var ev = sw.fireFetch({ method: 'GET', mode: 'navigate', url: SCOPE });
    await tick();                       // fetch 是在微任务里发起的，等一拍再断言
    ok('发起了网络请求', sw.fetches.length === 1, sw.fetches.length);
    sw.flushNetwork('HTML-FIRST');
    var res = await ev.responded;
    ok('用网络响应兜底', res.body === 'HTML-FIRST', res.body);
    await Promise.all(ev.waits);
    ok('并且写入了缓存', sw.store[INDEX].body === 'HTML-FIRST');
  }

  section('静态资源：stale-while-revalidate + ignoreSearch');

  {
    var sw = loadSW();
    var css = SCOPE + 'css/style.css';
    sw.seed(css, 'CSS-OLD');

    var ev = sw.fireFetch({ method: 'GET', mode: 'no-cors', url: css });
    var hit = await ev.responded;
    ok('命中缓存立即返回', hit.body === 'CSS-OLD', hit.body);
    ok('同时后台拉新版', sw.fetches.length === 1);

    sw.flushNetwork('CSS-NEW');
    await Promise.all(ev.waits);
    ok('后台写入新版', sw.store[css].body === 'CSS-NEW');

    // 带 ?v= 的请求也能命中同一条缓存（改版加查询串不会导致缓存击穿）
    var ev2 = sw.fireFetch({ method: 'GET', mode: 'no-cors', url: css + '?v=123' });
    var hit2 = await ev2.responded;
    ok('带查询串仍命中缓存（ignoreSearch）', hit2.body === 'CSS-NEW', hit2.body);
    sw.flushNetwork('CSS-NEW');
    await Promise.all(ev2.waits);
  }

  section('不该接管的请求一律放行');

  {
    var sw = loadSW();
    var ev = sw.fireFetch({ method: 'GET', mode: 'cors', url: 'https://cdn.other.test/lib.js' });
    ok('跨域请求直接放行（不接管、不缓存）',
      ev.responded === null && sw.fetches.length === 0);

    var ev2 = sw.fireFetch({ method: 'POST', mode: 'cors', url: SCOPE + 'api' });
    ok('非 GET 请求不接管', ev2.responded === null);
  }

  section('install：预缓存 + 不自动 skipWaiting');

  {
    var sw = loadSW();
    var ev = sw.fireLifecycle('install');
    await Promise.all(ev.waits);

    var list = sw.getAddAll();
    ok('预缓存了全部 SHELL 条目（' + SHELL_COUNT + '）', !!list && list.length === SHELL_COUNT,
      list && list.length);
    ok('预缓存请求带 cache: reload（绕过 HTTP 缓存）',
      !!list && list[0].opts.cache === 'reload', list && list[0].opts);
    ok('URL 都被解析成绝对地址（离线时不依赖相对路径）',
      !!list && list.every(function (r) { return r.url.indexOf(SCOPE) === 0; }));
    ok('install 阶段没有 skipWaiting（不会打断正在记账的用户）',
      sw.getSkipWaitingCount() === 0);
  }

  section('activate：清理旧缓存并接管页面');

  {
    var sw = loadSW();
    var ev = sw.fireLifecycle('activate');
    await Promise.all(ev.waits);

    ok('只删掉旧版本的缓存',
      sw.deleted.length === 1 && sw.deleted[0] === OLD_CACHE, sw.deleted.join(','));
    ok('当前版本的缓存被保留', sw.deleted.indexOf(CACHE_NAME) < 0);
    ok('不碰其它缓存（同域下别的应用不受影响）',
      sw.deleted.indexOf('unrelated-cache') < 0);
    ok('立即接管已有页面（clients.claim）', sw.getClaimCount() === 1);
  }

  section('message：只有收到 SKIP_WAITING 才切换版本');

  {
    var sw = loadSW();
    var ev = sw.fireLifecycle('message', { type: 'SKIP_WAITING' });
    ok('SKIP_WAITING 触发 skipWaiting', sw.getSkipWaitingCount() === 1 && ev.waits.length === 0);

    sw.fireLifecycle('message', { other: 1 });
    ok('其它消息不触发切换', sw.getSkipWaitingCount() === 1);

    sw.fireLifecycle('message', undefined);
    ok('空消息不报错也不切换', sw.getSkipWaitingCount() === 1);
  }

  /* -------------------------------------------------------------- */

  clearTimeout(watchdog);
  console.log('\nService Worker 测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) {
    console.log('\u274c 存在失败用例');
    process.exitCode = 1;
  }
})();