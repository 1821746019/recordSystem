/*!
 * storage.js —— 存储适配器
 * ---------------------------------------------------------------
 * 业务层只依赖统一的接口：
 *   adapter.getItem(key) -> string | null
 *   adapter.setItem(key, string)
 *   adapter.removeItem(key)
 *
 * 浏览器：createLocalStorageAdapter()
 * 内存（测试/兜底）：createMemoryAdapter()
 * 微信小程序：createWxStorageAdapter(wx)   ← 迁移时只需换成这个
 * 云开发/自建后端：照着同样的接口再写一个即可（配合 store 的 subscribe 做同步）。
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  }
  root.PrintSystem = root.PrintSystem || {};
  root.PrintSystem.Storage = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 内存适配器：不持久化，仅用于兜底与单元测试 */
  function createMemoryAdapter() {
    var mem = {};
    return {
      name: 'memory',
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
      },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }
    };
  }

  /** 浏览器 localStorage 适配器（不可用时自动降级为内存） */
  function createLocalStorageAdapter(storage) {
    var ls = storage;
    if (ls === undefined) {
      try {
        ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      } catch (e) {
        ls = null;
      }
    }
    if (!ls) return createMemoryAdapter();

    try {
      var probe = '__pps_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
    } catch (e) {
      return createMemoryAdapter();
    }

    return {
      name: 'localStorage',
      getItem: function (k) {
        try { return ls.getItem(k); } catch (e) { return null; }
      },
      setItem: function (k, v) {
        try { ls.setItem(k, v); } catch (e) { console.error('[storage] 写入失败（可能超出配额）', e); }
      },
      removeItem: function (k) {
        try { ls.removeItem(k); } catch (e) { /* ignore */ }
      }
    };
  }

  /**
   * 微信小程序适配器（迁移用）
   * @param {Object} wxApi 小程序里的 wx 对象
   */
  function createWxStorageAdapter(wxApi) {
    var wx = wxApi || (typeof wx !== 'undefined' ? wx : null);
    if (!wx) throw new Error('createWxStorageAdapter: 未找到 wx 对象');
    return {
      name: 'wxStorage',
      getItem: function (k) {
        try {
          var v = wx.getStorageSync(k);
          return (v === '' || v === undefined || v === null) ? null :
            (typeof v === 'string' ? v : JSON.stringify(v));
        } catch (e) { return null; }
      },
      setItem: function (k, v) {
        try { wx.setStorageSync(k, v); } catch (e) { console.error('[storage] wx 写入失败', e); }
      },
      removeItem: function (k) {
        try { wx.removeStorageSync(k); } catch (e) { /* ignore */ }
      }
    };
  }

  return {
    createMemoryAdapter: createMemoryAdapter,
    createLocalStorageAdapter: createLocalStorageAdapter,
    createWxStorageAdapter: createWxStorageAdapter
  };
});
