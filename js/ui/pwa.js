/*!
 * ui/pwa.js —— 离线与「安装到桌面」
 * ---------------------------------------------------------------
 * 做四件事：
 *   1. 注册 Service Worker（只有 https / localhost 能注册，file:// 静默跳过）
 *   2. 安卓 Chrome：接住 beforeinstallprompt，弹「安装到桌面」
 *   3. iOS Safari：没有安装 API，只能提示「分享 → 添加到主屏幕」
 *   4. 新版本就绪时提示「刷新」，避免用户长期用旧缓存
 *
 * 这里刻意**不依赖** DOM 工具模块，只用最基础的 DOM API，
 * 这样 tests/pwa.test.js 可以用 vm 把整个文件隔离加载后做行为测试。
 */
(function (root) {
  'use strict';

  var LS_KEY = 'printsystem.pwa.dismissed';
  var P = root.PrintSystem || (root.PrintSystem = {});
  var nav = root.navigator || {};
  var loc = root.location || {};

  var barEl = null;
  var deferredPrompt = null;
  var reloading = false;
  var hadController = !!(nav.serviceWorker && nav.serviceWorker.controller);

  /* ----------------------------- 小工具 ----------------------------- */

  function on(target, type, fn) {
    if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn);
  }

  /** 只有安全上下文才能注册 Service Worker */
  function isSecure() {
    var host = loc.hostname || '';
    return loc.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  }

  /** 是否已经从桌面图标启动（而不是浏览器标签页） */
  function isStandalone() {
    try {
      if (typeof root.matchMedia === 'function' &&
        root.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* 老浏览器忽略 */ }
    return nav.standalone === true;   // iOS 私有属性
  }

  function readDismissed(kind) {
    try {
      var raw = root.localStorage && root.localStorage.getItem(LS_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return !!obj[kind];
    } catch (e) {
      return false;
    }
  }

  function markDismissed(kind) {
    try {
      var raw = root.localStorage && root.localStorage.getItem(LS_KEY);
      var obj = {};
      try { obj = raw ? JSON.parse(raw) : {}; } catch (e2) { obj = {}; }
      obj[kind] = Date.now();
      if (root.localStorage) root.localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  /* ------------------------------ 提示条 ------------------------------ */

  function mk(tag, cls) {
    var el = root.document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  function hideBar() {
    if (barEl && barEl.parentNode) barEl.parentNode.removeChild(barEl);
    barEl = null;
  }

  /**
   * 底部提示条（复用 css 里的 .pwa-bar）
   * @param {String} kind 'install' | 'ios' | 'update'
   * @param {String} html 文案（可用 <b>）
   * @param {Array}  actions [{ label, primary, onClick }]
   */
  function showBar(kind, html, actions) {
    var body = root.document && root.document.body;
    if (!body) return null;

    hideBar();
    var bar = mk('div', 'pwa-bar');
    bar.setAttribute('data-kind', kind);
    bar.setAttribute('role', 'status');

    var text = mk('div', 'pwa-bar-text');
    text.innerHTML = html;
    bar.appendChild(text);

    (actions || []).forEach(function (action) {
      var btn = mk('button', 'mini-btn' + (action.primary ? ' primary' : ''));
      btn.type = 'button';
      btn.textContent = action.label;
      on(btn, 'click', action.onClick);
      bar.appendChild(btn);
    });

    body.appendChild(bar);
    barEl = bar;
    return bar;
  }

  /* --------------------------- 安装到桌面 --------------------------- */

  function askInstall() {
    var prompt = deferredPrompt;
    deferredPrompt = null;
    hideBar();
    if (!prompt || typeof prompt.prompt !== 'function') return;
    try { prompt.prompt(); } catch (e) { /* 已被用户处理过 */ }
    try {
      if (prompt.userChoice) prompt.userChoice.then(function () { /* 结果不用管 */ });
    } catch (e2) { /* 老实现没有 userChoice */ }
  }

  function offerInstall() {
    if (!deferredPrompt || isStandalone() || readDismissed('install')) return;
    showBar('install', '<b>装到桌面</b>：断网也能用，打开就是全屏', [
      {
        label: '以后',
        onClick: function () { markDismissed('install'); hideBar(); }
      },
      { label: '安装', primary: true, onClick: askInstall }
    ]);
  }

  function isIOS() {
    var ua = nav.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ 的 UA 伪装成 macOS，用触点数区分
    return /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
  }

  function offerIOS() {
    if (!isIOS() || isStandalone() || readDismissed('ios')) return;
    showBar('ios', '把本页 <b>分享 → 添加到主屏幕</b>，之后可离线使用', [
      {
        label: '知道了',
        onClick: function () { markDismissed('ios'); hideBar(); }
      }
    ]);
  }

  /* ---------------------------- 新版本 ---------------------------- */

  function offerUpdate(registration) {
    if (barEl && barEl.getAttribute && barEl.getAttribute('data-kind') === 'update') return;
    showBar('update', '发现<b>新版本</b>，刷新后生效', [
      { label: '稍后', onClick: hideBar },
      {
        label: '刷新',
        primary: true,
        onClick: function () {
          try {
            if (registration && registration.waiting) {
              registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
          } catch (e) { /* 忽略 */ }
          // 兜底：controllerchange 没等到也强制刷新
          root.setTimeout(function () {
            if (!reloading) { reloading = true; loc.reload(); }
          }, 1200);
        }
      }
    ]);
  }

  /* --------------------------- 注册 SW --------------------------- */

  function registerSW() {
    var container = nav.serviceWorker;
    if (!container || typeof container.register !== 'function') return null;
    if (!isSecure()) return null;   // file:// 或局域网 http 下静默跳过

    var promise;
    try {
      promise = container.register('./sw.js', { scope: './', updateViaCache: 'none' });
    } catch (e) {
      return null;
    }
    if (!promise || typeof promise.then !== 'function') return null;

    promise.then(function (registration) {
      on(registration, 'updatefound', function () {
        var installing = registration.installing;
        on(installing, 'statechange', function () {
          // 已经有页面在用旧版本 → 说明这是「更新」而不是首次安装
          if (installing && installing.state === 'installed' && container.controller) {
            offerUpdate(registration);
          }
        });
      });
      // 长期不关闭页面的场景：每 30 分钟主动查一次新版本
      if (typeof registration.update === 'function' && typeof root.setInterval === 'function') {
        root.setInterval(function () {
          try { registration.update(); } catch (e) { /* 离线忽略 */ }
        }, 30 * 60 * 1000);
      }
    }).catch(function (err) {
      if (root.console && root.console.warn) root.console.warn('[PWA] Service Worker 注册失败：', err);
    });

    // 新 SW 接管后刷新一次页面，保证资源与代码版本一致
    on(container, 'controllerchange', function () {
      if (!hadController) { hadController = true; return; }   // 首次安装不刷新
      if (reloading) return;
      reloading = true;
      loc.reload();
    });

    return promise;
  }

  /* ---------------------------- 启动 ---------------------------- */

  function init() {
    on(root, 'beforeinstallprompt', function (event) {
      // 阻止 Chrome 自带的迷你提示条，改用我们自己的（可控文案 + 记住「以后」）
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      deferredPrompt = event;
      offerInstall();
    });

    on(root, 'appinstalled', function () {
      deferredPrompt = null;
      hideBar();
    });

    registerSW();
    offerInstall();                 // 事件可能早于 DOMContentLoaded 触发
    if (typeof root.setTimeout === 'function') {
      root.setTimeout(offerIOS, 1500);   // 别和首屏渲染抢注意力
    }
  }

  if (root.document && root.document.readyState === 'loading') {
    on(root.document, 'DOMContentLoaded', init);
  } else {
    init();
  }

  P.PWA = {
    isSecure: isSecure,
    isStandalone: isStandalone,
    isIOS: isIOS,
    init: init,
    _showBar: showBar,
    _hideBar: hideBar,
    _getBar: function () { return barEl; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);