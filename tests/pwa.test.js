/*!
 * tests/pwa.test.js —— 离线能力（Service Worker / 安装到桌面）的测试
 * 运行：node tests/pwa.test.js
 *
 * 分两部分：
 *   A. 静态一致性 —— manifest / sw.js 的预缓存清单 / index.html 的引用 / 图标文件
 *      这几处最容易「改了代码忘了同步」，用测试锁死。
 *   B. 行为 —— 用 vm 把 js/ui/pwa.js 加载到隔离沙箱里，喂它不同的
 *      navigator / location / display-mode，检查它该注册就注册、该提示就提示。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..') + path.sep;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; console.log('  \u274c ' + name + (extra !== undefined ? '  => ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ======================================================================
 * A. 静态一致性
 * ==================================================================== */

var html = fs.readFileSync(ROOT + 'index.html', 'utf8');
var swSrc = fs.readFileSync(ROOT + 'sw.js', 'utf8');
var manifestRaw = fs.readFileSync(ROOT + 'manifest.webmanifest', 'utf8');
var cssSrc = fs.readFileSync(ROOT + 'css/style.css', 'utf8');

/** 从 index.html 里抠出所有本地引用的资源（脚本、样式、图标、manifest） */
function htmlAssets() {
  var out = [];
  var re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  var m;
  while ((m = re.exec(html))) {
    var url = m[1];
    if (/^(https?:)?\/\//.test(url)) continue;   // 外链
    if (url.charAt(0) === '#') continue;
    out.push(url.replace(/^\.\//, ''));
  }
  return out;
}

/** 从 sw.js 里抠出 SHELL 数组 */
function shellList() {
  var m = swSrc.match(/var SHELL\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  var list = [];
  var re = /'([^']+)'/g;
  var x;
  while ((x = re.exec(m[1]))) list.push(x[1].replace(/^\.\//, ''));
  return list;
}

section('manifest 基本字段');

var manifest = null;
try { manifest = JSON.parse(manifestRaw); } catch (e) { /* 下面会报错 */ }

ok('manifest 是合法 JSON', !!manifest);
ok('有 name / short_name', !!(manifest && manifest.name && manifest.short_name));
ok('start_url 指向本目录（离线可用）', !!manifest && manifest.start_url.indexOf('index.html') >= 0);
ok('scope 是相对目录', !!manifest && manifest.scope === './');
ok('display 是 standalone（像 App 一样全屏）', !!manifest && manifest.display === 'standalone');
ok('声明了 theme_color', !!(manifest && manifest.theme_color));

section('图标文件与 manifest 声明一致');

var iconFiles = (manifest && manifest.icons) || [];
function hasIcon(size, purpose) {
  return iconFiles.some(function (i) {
    return i.sizes === size && (!purpose || (i.purpose || 'any').indexOf(purpose) >= 0);
  });
}
ok('有 192×192 图标', hasIcon('192x192'));
ok('有 512×512 图标', hasIcon('512x512'));
ok('有 maskable 图标（安卓自适应）', hasIcon('512x512', 'maskable'));
iconFiles.forEach(function (i) {
  var p = ROOT + i.src.replace(/^\.\//, '');
  ok('图标文件存在：' + i.src, fs.existsSync(p));
});

section('index.html 的 PWA 接线');

ok('引入了 manifest', /rel="manifest"/.test(html));
ok('有 apple-touch-icon（iOS 桌面图标）', /rel="apple-touch-icon"/.test(html));
ok('有 apple-mobile-web-app-capable（iOS 全屏）', /apple-mobile-web-app-capable/.test(html));
ok('加载了 js/ui/pwa.js', /src="js\/ui\/pwa\.js"/.test(html));
ok('html 的 theme-color 与 manifest 一致',
  html.indexOf('content="' + (manifest && manifest.theme_color) + '"') >= 0);

section('页面引用的资源都真实存在');

htmlAssets().forEach(function (url) {
  var exists = fs.existsSync(ROOT + url);
  ok('文件存在：' + url, exists);
});

section('Service Worker 的预缓存清单是完整的');

var shell = shellList();
ok('sw.js 里有 SHELL 数组', Array.isArray(shell));

var shellSet = {};
(shell || []).forEach(function (u) { shellSet[u] = true; });

ok('SHELL 没有重复项', !shell || shell.length === Object.keys(shellSet).length);

(shell || []).forEach(function (u) {
  ok('预缓存的文件存在：' + u, fs.existsSync(ROOT + u));
});

// 关键回归：index.html 里引用的每个资源都必须在 SHELL 里，否则离线会缺文件
htmlAssets().forEach(function (url) {
  if (url === 'sw.js') return;                  // SW 本身不走缓存
  ok('index.html 引用的资源已预缓存：' + url, !!shellSet[url]);
});

section('sw.js 的缓存策略');

ok('有 CACHE_VERSION（改版时可作废旧缓存）', /var CACHE_VERSION\s*=/.test(swSrc));
ok('缓存名带版本号', /'print-record-'\s*\+\s*CACHE_VERSION/.test(swSrc));
ok('activate 里会清理旧版本缓存', /caches\.delete\(key\)/.test(swSrc));
ok('离线首屏：导航走缓存优先', /handleNavigate/.test(swSrc) && /cache\.match\(indexUrl\)/.test(swSrc));
ok('资源走 stale-while-revalidate', /ignoreSearch:\s*true/.test(swSrc));
ok('支持页面发 SKIP_WAITING', /SKIP_WAITING/.test(swSrc));

// install 阶段**不能**自动 skipWaiting，否则用户记账记一半资源被换掉
var installBlock = swSrc.slice(
  swSrc.indexOf("addEventListener('install'"),
  swSrc.indexOf("addEventListener('activate'")
);
// 注释里也会出现 skipWaiting 这个词（就是在解释为什么不用），所以先去掉注释再判断
var installCode = installBlock
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
ok('install 阶段不自动 skipWaiting（避免更新打断操作）',
  installBlock.length > 0 && installCode.indexOf('skipWaiting') < 0);

section('样式：提示条有对应规则');

ok('css 里定义了 .pwa-bar', /\.pwa-bar\s*\{/.test(cssSrc));
ok('.pwa-bar 用 flex 布局', /\.pwa-bar\s*\{[\s\S]*?display:\s*flex/.test(cssSrc));
ok('有全局 [hidden] 兜底（上一课的坑）', /\[hidden\][\s\S]{0,40}display:\s*none\s*!important/.test(cssSrc));

/* ======================================================================
 * B. 行为：vm 隔离加载 pwa.js
 * ==================================================================== */

var PWA_SRC = fs.readFileSync(ROOT + 'js' + path.sep + 'ui' + path.sep + 'pwa.js', 'utf8');

/** 同步 thenable：让 register(...).then(...).catch(...) 在同一次调用里跑完 */
function thenable(value) {
  var t = {
    then: function (onOk) {
      var r = onOk ? onOk(value) : value;
      return thenable(r === undefined ? value : r);
    },
    catch: function () { return t; }
  };
  return t;
}

function el(tag) {
  var e = {
    tagName: String(tag).toUpperCase(),
    className: '', innerHTML: '', textContent: '', type: '',
    attrs: {}, children: [], parentNode: null, listeners: {},
    setAttribute: function (k, v) { e.attrs[k] = v; },
    getAttribute: function (k) { return e.attrs[k] === undefined ? null : e.attrs[k]; },
    appendChild: function (c) { c.parentNode = e; e.children.push(c); return c; },
    removeChild: function (c) {
      var i = e.children.indexOf(c);
      if (i >= 0) e.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    addEventListener: function (t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); },
    fire: function (t, ev) {
      (e.listeners[t] || []).forEach(function (f) { f(ev || {}); });
    }
  };
  return e;
}

/**
 * 造一个浏览器环境并把 pwa.js 加载进去
 * @param {Object} opt 各种开关（见下）
 */
function loadPwa(opt) {
  opt = opt || {};

  var body = el('body');
  var doc = {
    readyState: 'complete',
    body: body,
    listeners: {},
    createElement: el,
    addEventListener: function (t, f) { (doc.listeners[t] = doc.listeners[t] || []).push(f); },
    fire: function (t, ev) { (doc.listeners[t] || []).forEach(function (f) { f(ev || {}); }); }
  };

  var data = {};
  var storage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
  if (opt.dismissed) storage.setItem('printsystem.pwa.dismissed', JSON.stringify(opt.dismissed));

  var registerCalls = [];
  var registration = null;
  var swContainer = {
    controller: opt.hadController ? {} : null,
    listeners: {},
    addEventListener: function (t, f) { (swContainer.listeners[t] = swContainer.listeners[t] || []).push(f); },
    fire: function (t, ev) { (swContainer.listeners[t] || []).forEach(function (f) { f(ev || {}); }); },
    register: function (url, opts) {
      registerCalls.push({ url: url, opts: opts });
      registration = {
        installing: null,
        waiting: null,
        updateCount: 0,
        listeners: {},
        addEventListener: function (t, f) {
          (registration.listeners[t] = registration.listeners[t] || []).push(f);
        },
        fire: function (t, ev) {
          (registration.listeners[t] || []).forEach(function (f) { f(ev || {}); });
        },
        update: function () { registration.updateCount++; }
      };
      return thenable(registration);
    }
  };

  var reloadCount = 0;
  var nav = {
    userAgent: opt.ua || 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile',
    serviceWorker: opt.noSW ? undefined : swContainer
  };
  if (opt.iosStandalone) nav.standalone = true;
  if (opt.maxTouchPoints) nav.maxTouchPoints = opt.maxTouchPoints;

  var ctx = {
    document: doc,
    navigator: nav,
    localStorage: storage,
    console: { warn: function () {}, log: function () {} },
    location: {
      protocol: opt.protocol || 'https:',
      hostname: opt.hostname === undefined ? 'user.github.io' : opt.hostname,
      reload: function () { reloadCount++; }
    },
    matchMedia: function (q) {
      return { matches: !!(opt.displayStandalone && q.indexOf('standalone') >= 0) };
    },
    setTimeout: function (fn) { fn(); return 0; },   // 同步执行，测试才确定
    setInterval: function () { return 0; },
    Promise: Promise,
    listeners: {},
    addEventListener: function (t, f) { (ctx.listeners[t] = ctx.listeners[t] || []).push(f); },
    fire: function (t, ev) { (ctx.listeners[t] || []).forEach(function (f) { f(ev || {}); }); }
  };

  vm.createContext(ctx);
  vm.runInContext(PWA_SRC, ctx, { filename: 'js/ui/pwa.js' });

  return {
    ctx: ctx,
    body: body,
    nav: nav,
    pwa: ctx.PrintSystem.PWA,
    registerCalls: registerCalls,
    getRegistration: function () { return registration; },
    getReloadCount: function () { return reloadCount; },
    bars: function () {
      return body.children.filter(function (c) { return /(^|\s)pwa-bar(\s|$)/.test(c.className); });
    },
    bar: function () { return body.children.filter(function (c) { return /(^|\s)pwa-bar(\s|$)/.test(c.className); })[0] || null; }
  };
}

/** 找到提示条上文字为 label 的按钮并点它 */
function clickButton(bar, label) {
  var btn = (bar.children || []).filter(function (c) {
    return c.tagName === 'BUTTON' && c.textContent === label;
  })[0];
  if (!btn) return false;
  btn.fire('click', {});
  return true;
}

section('行为：安全上下文才注册 Service Worker');

(function () {
  var env = loadPwa();   // https
  ok('https 下注册了 sw.js', env.registerCalls.length === 1,
    JSON.stringify(env.registerCalls));
  ok('注册时 scope 为当前目录', env.registerCalls[0] && env.registerCalls[0].opts.scope === './');
  ok('注册时绕过 HTTP 缓存（updateViaCache: none）',
    env.registerCalls[0] && env.registerCalls[0].opts.updateViaCache === 'none');
})();

(function () {
  var env = loadPwa({ protocol: 'file:', hostname: '' });
  ok('file:// 打开时**不**注册（浏览器也不允许）', env.registerCalls.length === 0);
  ok('file:// 下 isSecure() 返回 false', env.pwa.isSecure() === false);
})();

(function () {
  var env = loadPwa({ noSW: true });
  ok('浏览器不支持 serviceWorker 时不崩', env.registerCalls.length === 0 && !!env.pwa);
})();

section('行为：安卓「安装到桌面」');

(function () {
  var env = loadPwa();
  var prevented = false;
  var prompted = false;
  var choice = thenable('accepted');

  env.ctx.fire('beforeinstallprompt', {
    preventDefault: function () { prevented = true; },
    prompt: function () { prompted = true; },
    userChoice: choice
  });

  ok('拦住了 Chrome 自带的安装条', prevented);
  ok('弹出了我们自己的安装提示', !!env.bar());
  ok('提示条标记为 install', env.bar() && env.bar().getAttribute('data-kind') === 'install');
  ok('点了「安装」会调用 prompt()', clickButton(env.bar(), '安装') && prompted);
  ok('安装后提示条收起', env.bars().length === 0);
})();

(function () {
  var env = loadPwa({ dismissed: { install: 1 } });
  env.ctx.fire('beforeinstallprompt', {
    preventDefault: function () {}, prompt: function () {}, userChoice: thenable()
  });
  ok('用户选过「以后」就不再打扰', env.bars().length === 0);
})();

(function () {
  var env = loadPwa({ displayStandalone: true });
  env.ctx.fire('beforeinstallprompt', {
    preventDefault: function () {}, prompt: function () {}, userChoice: thenable()
  });
  ok('已经装了（standalone）就不再提示安装', env.bars().length === 0);
  ok('isStandalone() 能识别 display-mode', env.pwa.isStandalone() === true);
})();

section('行为：iOS 的「添加到主屏幕」');

(function () {
  var env = loadPwa({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1'
  });
  var bar = env.bar();
  ok('iPhone 上会给出 iOS 专属提示', !!bar);
  ok('提示条标记为 ios', bar && bar.getAttribute('data-kind') === 'ios');
  ok('文案提到「添加到主屏幕」', bar && bar.children[0].innerHTML.indexOf('添加到主屏幕') >= 0);
  ok('点「知道了」后收起并记住', clickButton(bar, '知道了') && env.bars().length === 0);
  ok('记忆已写入 localStorage',
    (env.ctx.localStorage.getItem('printsystem.pwa.dismissed') || '').indexOf('ios') >= 0);
})();

(function () {
  var env = loadPwa({
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1',
    iosStandalone: true
  });
  ok('已从桌面启动的 iOS 不再提示', env.bars().length === 0);
})();

section('行为：新版本提示');

(function () {
  var env = loadPwa({ hadController: true });
  var reg = env.getRegistration();
  ok('拿到了 registration', !!reg);

  // 模拟「发现新版本 → 装好待命」
  var installing = el('script');
  installing.state = 'installing';
  reg.installing = installing;
  reg.waiting = { posted: [], postMessage: function (m) { reg.waiting.posted.push(m); } };

  reg.fire('updatefound', {});
  installing.state = 'installed';
  installing.fire('statechange', {});

  var bar = env.bar();
  ok('出现「新版本」提示', !!bar && bar.getAttribute('data-kind') === 'update');

  clickButton(bar, '刷新');
  ok('点刷新会给新 SW 发 SKIP_WAITING',
    (reg.waiting.posted[0] || {}).type === 'SKIP_WAITING');
  ok('随后刷新页面', env.getReloadCount() >= 1);
})();

section('行为：首次安装不该触发刷新');

(function () {
  var env = loadPwa();          // controller 为 null = 首次访问
  env.ctx.navigator.serviceWorker.fire('controllerchange', {});
  ok('首次 claim 不会让页面重载', env.getReloadCount() === 0);

  env.ctx.navigator.serviceWorker.fire('controllerchange', {});
  ok('之后真正换版本才重载', env.getReloadCount() === 1);
})();

/* ---------------------------------------------------------------- */

console.log('\n离线能力测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('\u274c 存在失败用例');
  process.exitCode = 1;
}