/*!
 * ui/records.js —— 打印记录页（筛选 / 批量结算 / 编辑 / 删除）
 * 支持按学生搜索、日期范围、结清状态筛选，并实时汇总当前筛选结果。
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem = root.PrintSystem || {};
  var U = P.Utils;
  var DOM = P.UI.DOM;
  var Actions = P.UI.Actions;

  var RANGES = [
    { key: 'today', label: '今天' },
    { key: 'week', label: '本周' },
    { key: 'month', label: '本月' },
    { key: 'all', label: '全部' }
  ];
  var STATUS = [
    { key: 'all', label: '全部' },
    { key: 'unpaid', label: '未结清' },
    { key: 'paid', label: '已结清' }
  ];

  function buildFilter(state) {
    return {
      keyword: state.keyword,
      from: state.from,
      to: state.to,
      status: state.status
    };
  }

  function recordItem(rec, selected, batchCount) {
    var set = {};
    selected.forEach(function (id) { set[id] = true; });
    var alive = !!rec.studentId;
    return '' +
      '<article class="record-item' + (rec.paymentId ? ' is-paid' : '') + '" data-id="' + rec.id + '">' +
        '<label class="ck"><input type="checkbox" data-action="select"' + (set[rec.id] ? ' checked' : '') + '></label>' +
        '<div class="ri-main">' +
          '<div class="ri-top">' +
            '<span class="ri-date">' + DOM.esc(U.formatDateHuman(rec.date)) + '</span>' +
            '<span class="ri-name">' + DOM.esc(rec.studentName || '（未关联学生）') + '</span>' +
            (alive ? (rec.className ? '<span class="ri-class">' + DOM.esc(rec.className) + '</span>' : '') : '<span class="tag tag-dim">已删除</span>') +
            (batchCount > 1 ? '<span class="tag tag-batch">同批 ' + batchCount + '人</span>' : '') +
            '<span class="tag ' + (rec.paymentId ? 'tag-ok' : 'tag-warn') + '">' +
              (rec.paymentId ? '已结清' : '未结清') + '</span>' +
          '</div>' +
          '<div class="ri-mid">' +
            '<span>' + U.qty(rec.sheets) + ' 张</span>' +
            '<span>' + U.fenToYuan(rec.priceFen) + ' 元/张</span>' +
            '<span class="ri-time">' + DOM.esc(rec.time || '') + '</span>' +
          '</div>' +
          (rec.note ? '<div class="ri-note">' + DOM.esc(rec.note) + '</div>' : '') +
        '</div>' +
        '<div class="ri-right">' +
          '<div class="ri-amount">' + U.money(rec.amountFen) + '</div>' +
          '<div class="ri-ops">' +
            (rec.paymentId
              ? '<button type="button" class="mini-btn" data-action="unsettle">撤销结清</button>'
              : '<button type="button" class="mini-btn primary" data-action="settle">结算</button>') +
            '<button type="button" class="mini-btn" data-action="edit">编辑</button>' +
            '<button type="button" class="mini-btn danger" data-action="del">删除</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function render(ctx) {
    var state = ctx.state.records;
    var store = ctx.store;
    var records = store.queryRecords(buildFilter(state));
    var sum = store.summarize(records);
    var selectedSet = {};
    state.selected.forEach(function (id) { selectedSet[id] = true; });
    var selected = records.filter(function (r) { return selectedSet[r.id]; });
    var selSum = U.sum(selected, function (r) { return r.amountFen; });
    var batchCounts = store.batchCounts();
    var html = '';

    /* 筛选区 */
    html += '<section class="card filters">';
    html += '  <div class="search-row">';
    html += '    <input class="input" id="r-keyword" type="search" placeholder="学生姓名 / 拼音 / 首字母 / 备注" value="' + DOM.esc(state.keyword) + '">';
    html += '  </div>';
    html += '  <div class="range-row">';
    html += '    <input class="input" type="date" id="r-from" value="' + DOM.esc(state.from) + '">';
    html += '    <span class="range-sep">至</span>';
    html += '    <input class="input" type="date" id="r-to" value="' + DOM.esc(state.to) + '">';
    html += '  </div>';
    html += '  <div class="chips">' + RANGES.map(function (r) {
      return '<button type="button" class="chip' + (state.range === r.key ? ' active' : '') +
        '" data-action="range" data-key="' + r.key + '">' + r.label + '</button>';
    }).join('') + '</div>';
    html += '  <div class="chips">' + STATUS.map(function (s) {
      return '<button type="button" class="chip' + (state.status === s.key ? ' active' : '') +
        '" data-action="status" data-key="' + s.key + '">' + s.label + '</button>';
    }).join('') + '</div>';
    html += '  <div class="filter-summary">' +
      '共 <b>' + sum.count + '</b> 条 · 合计 <b>' + U.money(sum.amountFen) + '</b>' +
      ' · 未结清 <b class="warn">' + U.money(sum.unpaidFen) + '</b>' +
      ' · ' + sum.sheets + ' 张' +
      '</div>';
    html += '</section>';

    /* 批量操作条 */
    html += '<div class="list-tools">';
    html += '  <label class="ck-inline"><input type="checkbox" id="r-all"' +
      (records.length && selected.length === records.length ? ' checked' : '') + '> 全选当前 ' + records.length + ' 条</label>';
    html += '  <div class="tools-right">';
    if (selected.length) {
      html += '<button type="button" class="mini-btn" data-action="batch-unsettle">撤销结清</button>';
      html += '<button type="button" class="mini-btn danger" data-action="batch-delete">删除</button>';
      html += '<button type="button" class="mini-btn primary" data-action="batch-settle">结算 ' + U.money(selSum) + '</button>';
    } else {
      html += '<button type="button" class="mini-btn" data-action="export">导出 CSV</button>';
    }
    html += '  </div>';
    html += '</div>';

    /* 列表 */
    html += '<section class="record-list">';
    if (!records.length) {
      html += '<div class="empty">' +
        '<div class="empty-icon">🗂️</div>' +
        '<div>还没有符合条件的记录</div>' +
        '<div class="hint">去「记账」页添加第一条吧</div>' +
        '</div>';
    } else {
      records.slice(0, 300).forEach(function (rec) {
        html += recordItem(rec, state.selected, batchCounts[rec.batchId] || 0);
      });
      if (records.length > 300) {
        html += '<div class="hint center">仅显示最近 300 条，请用筛选缩小范围（导出 CSV 会包含全部结果）</div>';
      }
    }
    html += '</section>';

    return html;
  }

  function mount(ctx, rootEl) {
    var state = ctx.state.records;
    var store = ctx.store;
    var app = ctx.app;

    function currentRecords() {
      return store.queryRecords(buildFilter(state));
    }

    function selectedRecords() {
      var set = {};
      state.selected.forEach(function (id) { set[id] = true; });
      return store.getState().records.filter(function (r) { return set[r.id]; });
    }

    /* 搜索（输入即筛，无需点按钮） */
    DOM.on(rootEl, 'input', '#r-keyword', function (e, el) {
      state.keyword = el.value;
      state.selected = [];
      app.refresh();
      // 重绘后容器是新的，要从当前页面重新取输入框，保持焦点与光标位置
      var next = DOM.qs('#r-keyword');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    });

    DOM.on(rootEl, 'change', '#r-from', function (e, el) {
      state.from = el.value; state.range = 'custom'; state.selected = []; app.refresh();
    });
    DOM.on(rootEl, 'change', '#r-to', function (e, el) {
      state.to = el.value; state.range = 'custom'; state.selected = []; app.refresh();
    });

    DOM.on(rootEl, 'click', '[data-action="range"]', function (e, btn) {
      var key = btn.dataset.key;
      var r = DOM.rangeOf(key);
      state.range = key;
      state.from = r.from;
      state.to = r.to;
      state.selected = [];
      app.refresh();
    });

    DOM.on(rootEl, 'click', '[data-action="status"]', function (e, btn) {
      state.status = btn.dataset.key;
      state.selected = [];
      app.refresh();
    });

    /* 勾选 */
    DOM.on(rootEl, 'change', '[data-action="select"]', function (e, el) {
      var item = el.closest('.record-item');
      var id = item && item.dataset.id;
      if (!id) return;
      var i = state.selected.indexOf(id);
      if (el.checked && i < 0) state.selected.push(id);
      if (!el.checked && i >= 0) state.selected.splice(i, 1);
      app.refresh();
    });

    DOM.on(rootEl, 'change', '#r-all', function (e, el) {
      state.selected = el.checked ? currentRecords().map(function (r) { return r.id; }) : [];
      app.refresh();
    });

    /* 单条操作 */
    DOM.on(rootEl, 'click', '[data-action="edit"]', function (e, btn) {
      var id = btn.closest('.record-item').dataset.id;
      Actions.openRecordEdit(ctx, store.getRecord(id));
    });

    DOM.on(rootEl, 'click', '[data-action="settle"]', function (e, btn) {
      var id = btn.closest('.record-item').dataset.id;
      var rec = store.getRecord(id);
      Actions.openSettle(ctx, [rec], { studentId: rec.studentId });
    });

    DOM.on(rootEl, 'click', '[data-action="unsettle"]', function (e, btn) {
      var id = btn.closest('.record-item').dataset.id;
      DOM.confirm({
        title: '撤销结清',
        content: '这条记录会回到「未结清」状态，关联的收款单若没有其它记录将被删除。继续吗？'
      }).then(function (ok) {
        if (!ok) return;
        store.unsettleRecords([id]);
        DOM.toast('已撤销结清', 'success');
        app.refresh();
      });
    });

    DOM.on(rootEl, 'click', '[data-action="del"]', function (e, btn) {
      var id = btn.closest('.record-item').dataset.id;
      Actions.confirmDeleteRecords(ctx, [store.getRecord(id)]);
    });

    /* 批量操作 */
    DOM.on(rootEl, 'click', '[data-action="batch-settle"]', function () {
      var recs = selectedRecords();
      if (!recs.length) return;
      var first = recs[0];
      var sameStudent = recs.every(function (r) { return r.studentId === first.studentId; });
      if (!sameStudent) {
        DOM.confirm({
          title: '跨学生结算',
          content: '选中的记录属于不同学生，会把它们合并到一张收款单里（收款人显示为第一位的学生）。建议先按学生筛选再结算。是否继续？'
        }).then(function (ok) {
          if (ok) Actions.openSettle(ctx, recs, { studentId: first.studentId });
        });
        return;
      }
      Actions.openSettle(ctx, recs, { studentId: first.studentId });
    });

    DOM.on(rootEl, 'click', '[data-action="batch-unsettle"]', function () {
      var recs = selectedRecords().filter(function (r) { return r.paymentId; });
      if (!recs.length) { DOM.toast('选中的记录都还没结清', 'error'); return; }
      DOM.confirm({
        title: '批量撤销结清',
        content: '将把选中的 ' + recs.length + ' 条记录恢复为「未结清」，继续吗？'
      }).then(function (ok) {
        if (!ok) return;
        store.unsettleRecords(recs.map(function (r) { return r.id; }));
        state.selected = [];
        DOM.toast('已撤销 ' + recs.length + ' 条', 'success');
        app.refresh();
      });
    });

    DOM.on(rootEl, 'click', '[data-action="batch-delete"]', function () {
      var recs = selectedRecords();
      if (!recs.length) return;
      Actions.confirmDeleteRecords(ctx, recs).then(function (ok) {
        if (ok) { state.selected = []; app.refresh(); }
      });
    });

    DOM.on(rootEl, 'click', '[data-action="export"]', function () {
      var recs = currentRecords();
      DOM.download('打印记录_' + U.todayString() + '.csv', store.exportRecordsCSV(recs), 'text/csv;charset=utf-8');
      DOM.toast('已导出 ' + recs.length + ' 条记录', 'success');
    });
  }

  P.UI.Records = { render: render, mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);