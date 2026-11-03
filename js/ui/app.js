/*!
 * ui/app.js —— 应用外壳（标签页切换、顶部概览、事件总线）
 * 负责把 store（数据）和各个 view（界面）粘在一起。
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem;
  var U = P.Utils;
  var DOM = P.UI.DOM;

  /* ------------------------- 数据仓库 ------------------------- */
  /* 小程序里只要把这一行换成：
   *   P.Store.create({ adapter: P.Storage.createWxStorageAdapter(wx) })
   */
  var store = P.Store.create({});

  /* ------------------------- 标签页 ------------------------- */
  var TABS = [
    { id: 'quick', label: '记账', icon: '✍️', view: 'Quick' },
    { id: 'records', label: '记录', icon: '📋', view: 'Records' },
    { id: 'students', label: '学生', icon: '🧑‍🎓', view: 'Students' },
    { id: 'stats', label: '统计', icon: '📊', view: 'Stats' },
    { id: 'settings', label: '设置', icon: '⚙️', view: 'Settings' }
  ];

  /* ------------------------- 应用状态（界面态，不持久化） ------------------------- */
  var state = {
    quick: {
      selectedIds: [],            // 已勾选的学生 id（支持多选）
      search: '',                 // 学生搜索框内容（可用 , 分隔多个）
      autoMap: {},                // { token: [ids] } 每个分隔词自动勾选了谁（用于回退）
      excluded: [],               // 用户手动取消勾选过的人（本次输入期间不再自动勾选）
      sheets: 0,                  // 每人打印张数（支持 0.5 张粒度）
      date: U.todayString(),
      time: U.toTimeString(Date.now()),
      note: '',
      lastBatchId: '',            // 最近保存的一批（用于「撤销这一批」）
      lastBatchCount: 0,
      lastBatchTotalFen: 0
    },
    records: {
      keyword: '',
      from: '',
      to: '',
      range: 'all',
      status: 'all',
      selected: []
    },
    students: {
      keyword: '',
      sort: 'unpaid',
      expanded: {}
    },
    stats: {}
  };

  var currentTab = 'quick';

  /* ------------------------- 概览条 ------------------------- */
  function overviewHTML() {
    var ov = store.overview();
    return '' +
      '<section class="overview">' +
        '<div class="ov-card">' +
          '<span class="ov-label">今日</span>' +
          '<b class="ov-value">' + U.qty(ov.today.sheets) + ' 张</b>' +
          '<em class="ov-sub">' + U.money(ov.today.amountFen) + '</em>' +
        '</div>' +
        '<div class="ov-card">' +
          '<span class="ov-label">本月</span>' +
          '<b class="ov-value">' + U.qty(ov.month.sheets) + ' 张</b>' +
          '<em class="ov-sub">' + U.money(ov.month.amountFen) + '</em>' +
        '</div>' +
        '<div class="ov-card' + (ov.unpaidFen > 0 ? ' alert' : '') + '">' +
          '<span class="ov-label">未结清</span>' +
          '<b class="ov-value">' + U.money(ov.unpaidFen) + '</b>' +
          '<em class="ov-sub">' + ov.unpaidCount + ' 条待结</em>' +
        '</div>' +
      '</section>';
  }

  /* ------------------------- 渲染 ------------------------- */
  var viewEl, tabbarEl, headerTitle, headerSub;

  function renderTabbar() {
    tabbarEl.innerHTML = TABS.map(function (t) {
      return '<button type="button" class="tab' + (t.id === currentTab ? ' active' : '') + '" data-tab="' + t.id + '">' +
        '<span class="tab-icon">' + t.icon + '</span>' +
        '<span class="tab-label">' + t.label + '</span>' +
        '</button>';
    }).join('');
  }

  function renderHeader() {
    var s = store.getSettings();
    headerTitle.textContent = s.shopName || '打印记录系统';
    headerSub.textContent = P.Pricing.describe(s) + (s.operator ? ' · ' + s.operator : '');
  }

  function render() {
    var tab = TABS.filter(function (t) { return t.id === currentTab; })[0] || TABS[0];
    var view = P.UI[tab.view];
    var ctx = {
      app: app,
      store: store,
      state: state,
      U: U,
      DOM: DOM
    };

    // 页面重绘前，先让上一个页面解绑它挂在 document / window 上的全局监听
    if (typeof P.UI.cleanup === 'function') {
      try { P.UI.cleanup(); } catch (e) { console.error('[ui] cleanup 出错', e); }
      P.UI.cleanup = null;
    }

    if (view && typeof view.render === 'function') {
      P.UI.mountView(view, viewEl, ctx, tab.id === 'settings' ? '' : overviewHTML());
    } else {
      viewEl.innerHTML = '<div class="empty">页面加载失败：' + tab.view + '</div>';
    }

    renderTabbar();
    renderHeader();
  }

  /**
   * 把页面渲染到「每次全新」的容器里，再挂载事件。
   *
   * ★ 关键：页面的事件（点编辑、点删除…）都是委托绑定在 mount 收到的那个元素上。
   *   如果直接挂到常驻的 #view 上，每重绘一次就会再挂一层，
   *   于是「点一次编辑」会触发 N 次 → 弹出 N 个弹窗。
   *   所以这里每次都新建一个 div 作为挂载点，上一个连它的事件监听一起被丢弃。
   *
   * @param {Object} view     页面对象，提供 render(ctx) / mount(ctx, root)
   * @param {Element} container 常驻外层容器（#view）
   * @param {Object} ctx      上下文
   * @param {String} prefixHTML 页面内容之前要插入的 HTML（如顶部概览条）
   * @return {Element} 本次的挂载点（新的 div）
   */
  function mountView(view, container, ctx, prefixHTML) {
    var root = document.createElement('div');
    root.className = 'view-root';
    var html = prefixHTML || '';
    if (view && typeof view.render === 'function') {
      html += view.render(ctx);
    }
    root.innerHTML = html;

    container.innerHTML = '';      // 丢掉上一版 DOM（连同它上面的监听）
    container.appendChild(root);

    if (view && typeof view.mount === 'function') {
      view.mount(ctx, root);
    }
    return root;
  }

  // 暴露给测试用（也方便其它页面手动复用这套「全新容器」挂载方式）
  P.UI.mountView = mountView;

  /* ------------------------- 对外接口 ------------------------- */
  var app = {
    store: store,
    state: state,
    refresh: render,

    go: function (tabId) {
      if (!TABS.some(function (t) { return t.id === tabId; })) return;
      currentTab = tabId;
      window.scrollTo(0, 0);
      render();
    },

    getTab: function () { return currentTab; },

    toast: DOM.toast,
    modal: DOM.openModal,
    confirm: DOM.confirm,
    download: DOM.download
  };

  /* ------------------------- 启动 ------------------------- */
  function boot() {
    viewEl = document.getElementById('view');
    tabbarEl = document.getElementById('tabbar');
    headerTitle = document.getElementById('shop-name');
    headerSub = document.getElementById('price-desc');

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      var btn = t.closest('[data-tab]');
      if (btn) app.go(btn.dataset.tab);
    });

    // 数据一变就重新渲染当前页面
    store.subscribe(function () { render(); });

    // 数据存不进去（比如隐私模式）时给个提示，避免用户以为白记了
    if (store.storageName === 'memory') {
      setTimeout(function () {
        DOM.toast('提示：当前环境无法本地保存，数据仅本次有效', 'error', 4000);
      }, 800);
    }

    render();

    // 跨标签页/跨天回到前台时刷新一下（今天是哪天会变、别的标签页可能改了数据）
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        store.reload();
        state.quick.date = state.quick.date || U.todayString();
      }
    });

    P.app = app;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);