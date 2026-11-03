/*!
 * sw.js —— Service Worker：让整个 App 断网也能启动
 * ---------------------------------------------------------------
 * 缓存策略：
 *   1. install  —— 把下面 SHELL 里的静态资源全部预缓存（离线首屏就靠它）
 *   2. 导航请求 —— stale-while-revalidate：缓存秒开 + 后台校验回填
 *   3. 静态资源 —— stale-while-revalidate（先用缓存，同时后台拉新版）
 *   4. 跨域请求 —— 直接放行（本项目没有外部请求，留作保险）
 *
 * 两个注意点：
 *   - 新增/删除源文件时**必须同步改下面的 SHELL**，否则离线会缺文件。
 *     tests/pwa.test.js 会拿 index.html 里的引用做比对，漏了会直接测试失败。
 *   - 改代码后不需要手动升版本：静态资源走 SWR，下一次启动就换新。
 *     只有想「立刻作废所有人的旧缓存」时才把 CACHE_VERSION 加一。
 */
'use strict';

var CACHE_VERSION = 'v2';   // 改了缓存策略/资源清单后 +1，会强制丢掉旧缓存
var CACHE_NAME = 'print-record-' + CACHE_VERSION;

/** 需要预缓存的资源（相对 Service Worker 所在目录） */
var SHELL = [
  './index.html',
  './manifest.webmanifest',
  './css/style.css',

  './js/vendor/tiny-pinyin.js',

  './js/core/utils.js',
  './js/core/pricing.js',
  './js/core/pinyin.js',
  './js/core/storage.js',
  './js/core/store.js',

  './js/ui/dom.js',
  './js/ui/actions.js',
  './js/ui/quick.js',
  './js/ui/records.js',
  './js/ui/students.js',
  './js/ui/stats.js',
  './js/ui/settings.js',
  './js/ui/pwa.js',
  './js/ui/app.js',

  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png'
];

/* ------------------------- 安装：预缓存 ------------------------- */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // cache: 'reload' 绕过 HTTP 缓存，保证装进去的是最新版本
      return cache.addAll(SHELL.map(function (url) {
        return new Request(new URL(url, self.registration.scope).href, { cache: 'reload' });
      }));
    })
    // 注意：这里**不**调用 skipWaiting()。
    // 新版本先「待命」，由页面提示用户点「刷新」再切换，
    // 避免用户正记着账、页面资源却被换掉一半。
  );
});

/* ------------------- 激活：清掉旧版本缓存 ------------------- */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf('print-record-') === 0 && key !== CACHE_NAME) {
          return caches.delete(key);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* -------------------------- 取数据 -------------------------- */

/**
 * 导航请求：同样是 stale-while-revalidate
 * ---------------------------------------------------------------
 * 先用缓存的 index.html **秒开**，同时后台用 `cache: 'no-cache'` 校验一次
 * （Pages 会回 304，几乎不耗流量）；真有新版本就静默写回缓存，**下次启动**生效。
 *
 * 为什么不能只做"缓存优先"：那样 index.html 一旦进缓存就再也不会更新，
 * 只要某次发布只改了 HTML、没改 sw.js，用户就会一直看到旧页面。
 *
 * 注意这里请求的是 indexUrl（不带 query），保证缓存键稳定。
 */
function handleNavigate(event, request) {
  var indexUrl = new URL('index.html', self.registration.scope).href;
  var cachePromise = caches.open(CACHE_NAME);
  var networkPromise = cachePromise.then(function (cache) {
    return fetch(indexUrl, { cache: 'no-cache' }).then(function (response) {
      if (response && response.ok) cache.put(indexUrl, response.clone());
      return response;
    });
  });

  // waitUntil 必须在事件分发期间同步调用，所以这里不能在 await 之后调用
  event.waitUntil(networkPromise.catch(function () { /* 离线：忽略 */ }));

  return cachePromise.then(function (cache) {
    return cache.match(indexUrl);
  }).then(function (hit) {
    return hit || networkPromise;
  });
}

/**
 * 静态资源：stale-while-revalidate
 * 先返回缓存（快），同时后台请求新版写回缓存（下次生效）。
 */
function handleAsset(event, request) {
  var cachePromise = caches.open(CACHE_NAME);
  var networkPromise = cachePromise.then(function (cache) {
    return fetch(request).then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    });
  });

  // waitUntil 必须在事件分发期间同步调用，所以这里不能在 await 之后调用
  event.waitUntil(networkPromise.catch(function () { /* 离线：忽略 */ }));

  return cachePromise.then(function (cache) {
    return cache.match(request, { ignoreSearch: true });
  }).then(function (hit) {
    return hit || networkPromise;
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // 跨域放行（本项目没有外部依赖）


  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(event, request));
    return;
  }
  event.respondWith(handleAsset(event, request));
});

/* -------------------- 与页面通信（切换版本） -------------------- */

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});
