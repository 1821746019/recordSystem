/*!
 * ui/stats.js —— 统计页（总览 / 月度汇总 / 学生排行 / 收款记录 / 导出）
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem = root.PrintSystem || {};
  var U = P.Utils;
  var DOM = P.UI.DOM;

  function render(ctx) {
    var store = ctx.store;
    var state = ctx.state.stats;
    var ov = store.overview();
    var html = '';

    /* 总览 */
    html += '<section class="card">';
    html += '  <div class="card-title">总览</div>';
    html += '  <div class="stat-grid">';
    html += '    <div class="stat"><span class="stat-label">学生数</span><b>' + ov.studentCount + '</b></div>';
    html += '    <div class="stat"><span class="stat-label">记录条数</span><b>' + ov.recordCount + '</b></div>';
    html += '    <div class="stat"><span class="stat-label">打印张数</span><b>' + U.qty(ov.sheets) + '</b></div>';
    html += '    <div class="stat"><span class="stat-label">人均张数</span><b>' +
      U.qty(ov.recordCount ? ov.sheets / ov.recordCount : 0) + '</b></div>';
    html += '    <div class="stat"><span class="stat-label">应收总额</span><b>' + U.money(ov.amountFen) + '</b></div>';
    html += '    <div class="stat"><span class="stat-label">实收金额</span><b>' + U.money(ov.receivedFen) + '</b></div>';
    html += '    <div class="stat hot"><span class="stat-label">未结清</span><b>' + U.money(ov.unpaidFen) + '</b>' +
      '<em>' + ov.unpaidCount + ' 条</em></div>';
    html += '    <div class="stat"><span class="stat-label">已结清</span><b>' + U.money(ov.paidFen) + '</b></div>';
    html += '  </div>';
    html += '  <div class="hint">本月 ' + ov.month.month + '：' + ov.month.count + ' 条 · ' + ov.month.sheets +
      ' 张 · ' + U.money(ov.month.amountFen) + '；今日 ' + ov.today.count + ' 条 · ' + ov.today.sheets +
      ' 张 · ' + U.money(ov.today.amountFen) + '</div>';
    html += '</section>';

    /* 未结清名单 */
    var unpaid = store.unpaidStudents();
    html += '<section class="card">';
    html += '  <div class="card-title">欠款名单（' + unpaid.length + '）</div>';
    if (!unpaid.length) {
      html += '  <div class="hint">太棒了，所有账都结清了 🎉</div>';
    } else {
      html += '  <div class="rank-list">';
      unpaid.slice(0, 20).forEach(function (st) {
        html += '<div class="rank-row" data-id="' + st.student.id + '">' +
          '<span class="rk-name">' + DOM.esc(st.student.name) + '</span>' +
          '<span class="rk-meta">' + st.unpaidCount + ' 条 · ' + st.sheets + ' 张</span>' +
          '<span class="rk-money warn">' + U.money(st.unpaidFen) + '</span>' +
          '<button type="button" class="mini-btn primary" data-action="settle-student" data-id="' + st.student.id + '">结算</button>' +
          '</div>';
      });
      html += '  </div>';
    }
    html += '</section>';

    /* 月度汇总 */
    var months = store.monthlyStats();
    html += '<section class="card">';
    html += '  <div class="card-title">月度汇总</div>';
    if (!months.length) {
      html += '  <div class="hint">暂无数据</div>';
    } else {
      html += '  <div class="table-wrap"><table class="data-table">';
      html += '    <thead><tr><th>月份</th><th>条数</th><th>张数</th><th>应收</th><th>实收</th><th>未结</th></tr></thead><tbody>';
      months.forEach(function (m) {
        html += '<tr>' +
          '<td>' + m.month + '</td>' +
          '<td>' + m.count + '</td>' +
          '<td>' + U.qty(m.sheets) + '</td>' +
          '<td>' + U.money(m.amountFen) + '</td>' +
          '<td>' + U.money(m.receivedFen) + '</td>' +
          '<td class="' + (m.unpaidFen > 0 ? 'warn' : '') + '">' + U.money(m.unpaidFen) + '</td>' +
          '</tr>';
      });
      html += '    </tbody></table></div>';
    }
    html += '</section>';

    /* 学生排行 */
    var rank = store.studentRanking({});
    var max = rank.length ? rank[0].amountFen : 1;
    html += '<section class="card">';
    html += '  <div class="card-title">学生消费排行</div>';
    if (!rank.length) {
      html += '  <div class="hint">暂无数据</div>';
    } else {
      html += '  <div class="rank-list">';
      rank.slice(0, 20).forEach(function (st, i) {
        var pct = Math.max(4, Math.round(st.amountFen / (max || 1) * 100));
        html += '<div class="rank-row">' +
          '<span class="rk-no">' + (i + 1) + '</span>' +
          '<span class="rk-name">' + DOM.esc(st.student.name) +
            '<em>' + DOM.esc(st.student.className || '') + '</em>' +
            '<i class="bar"><i style="width:' + pct + '%"></i></i>' +
          '</span>' +
          '<span class="rk-meta">' + U.qty(st.sheets) + ' 张</span>' +
          '<span class="rk-money">' + U.money(st.amountFen) + '</span>' +
          '</div>';
      });
      html += '  </div>';
    }
    html += '</section>';

    /* 批量记账批次 */
    var batches = store.batchList({});
    html += '<section class="card">';
    html += '  <div class="card-title">批量记账批次（最近 10 批）</div>';
    if (!batches.length) {
      html += '  <div class="hint">还没有批量记账。在「记账」页一次勾选多名学生保存后，这里会按批汇总。</div>';
    } else {
      html += '  <div class="batch-list">';
      batches.slice(0, 10).forEach(function (b, i) {
        html += '<div class="batch-row">' +
          '<div class="br-main">' +
            '<span class="br-title">' + DOM.esc(U.formatDateHuman(b.date)) + ' · ' + b.count + ' 人 · ' +
              b.count + ' × ' + U.money(b.perAmountFen) + ' = ' + U.money(b.amountFen) + '</span>' +
            '<span class="br-meta">' + DOM.esc(b.studentNames.join('、')) + '</span>' +
            '<span class="br-meta">每人 ' + U.qty(b.perSheets) + ' 张 · 本批共 ' + U.qty(b.sheets) + ' 张' +
              (b.note ? ' · ' + DOM.esc(b.note) : '') +
              (b.unpaidFen > 0 ? ' · <b class="warn">未结清 ' + U.money(b.unpaidFen) + '</b>' : '') + '</span>' +
          '</div>' +
          '<button type="button" class="mini-btn danger" data-action="del-batch" data-id="' + b.batchId + '">撤销本批</button>' +
          '</div>';
      });
      html += '  </div>';
    }
    html += '</section>';

    /* 收款记录 */
    var payments = store.listPayments({});
    html += '<section class="card">';
    html += '  <div class="card-title">收款记录（最近 20 笔）</div>';
    if (!payments.length) {
      html += '  <div class="hint">还没有收款记录。在「记录」或「学生」页点「结算」即可生成。</div>';
    } else {
      html += '  <div class="payment-list">';
      payments.slice(0, 20).forEach(function (p) {
        html += '<div class="payment-row" data-id="' + p.id + '">' +
          '<div class="pr-main">' +
            '<span class="pr-name">' + DOM.esc(p.studentName || '（未关联）') + '</span>' +
            '<span class="pr-meta">' + DOM.esc(p.date) + ' · ' + DOM.esc(p.method) + ' · ' + p.recordIds.length + ' 条' +
              (p.discountFen > 0 ? ' · 优惠 ' + U.money(p.discountFen) : '') + '</span>' +
            (p.note ? '<span class="pr-note">' + DOM.esc(p.note) + '</span>' : '') +
          '</div>' +
          '<div class="pr-right">' +
            '<b>' + U.money(p.amountFen) + '</b>' +
            '<button type="button" class="mini-btn danger" data-action="del-payment" data-id="' + p.id + '">撤销</button>' +
          '</div>' +
          '</div>';
      });
      html += '  </div>';
    }
    html += '</section>';

    /* 导出 */
    html += '<section class="card">';
    html += '  <div class="card-title">导出报表</div>';
    html += '  <div class="btn-row">';
    html += '    <button type="button" class="btn btn-soft" data-action="exp-records">记录明细 CSV</button>';
    html += '    <button type="button" class="btn btn-soft" data-action="exp-students">学生汇总 CSV</button>';
    html += '    <button type="button" class="btn btn-soft" data-action="exp-payments">收款记录 CSV</button>';
    html += '    <button type="button" class="btn btn-soft" data-action="exp-batches">批次汇总 CSV</button>';
    html += '  </div>';
    html += '  <div class="hint">CSV 带 BOM，用 Excel / WPS / 手机表格直接打开不会乱码。</div>';
    html += '</section>';

    return html;
  }

  function mount(ctx, rootEl) {
    var store = ctx.store;
    var app = ctx.app;

    DOM.on(rootEl, 'click', '[data-action="settle-student"]', function (e, btn) {
      var id = btn.dataset.id || (btn.closest('.rank-row') && btn.closest('.rank-row').dataset.id);
      if (!id) return;
      var recs = store.getState().records.filter(function (r) { return r.studentId === id && !r.paymentId; });
      if (!recs.length) { DOM.toast('该学生没有未结清记录', 'error'); return; }
      P.UI.Actions.openSettle(ctx, recs, { studentId: id });
    });

    DOM.on(rootEl, 'click', '[data-action="del-payment"]', function (e, btn) {
      var id = btn.dataset.id;
      var p = store.getPayment(id);
      if (!p) return;
      DOM.confirm({
        title: '撤销收款',
        content: '将删除这笔收款记录（' + U.money(p.amountFen) + '），并把关联的 ' + p.recordIds.length +
          ' 条打印记录恢复为「未结清」。继续吗？',
        okText: '撤销收款'
      }).then(function (ok) {
        if (!ok) return;
        store.deletePayment(id);
        DOM.toast('已撤销该笔收款', 'success');
        app.refresh();
      });
    });

    DOM.on(rootEl, 'click', '[data-action="exp-records"]', function () {
      DOM.download('打印记录明细_' + U.todayString() + '.csv', store.exportRecordsCSV(null), 'text/csv;charset=utf-8');
    });
    DOM.on(rootEl, 'click', '[data-action="exp-students"]', function () {
      DOM.download('学生汇总_' + U.todayString() + '.csv', store.exportStudentsCSV(), 'text/csv;charset=utf-8');
    });
    DOM.on(rootEl, 'click', '[data-action="exp-payments"]', function () {
      DOM.download('收款记录_' + U.todayString() + '.csv', store.exportPaymentsCSV(), 'text/csv;charset=utf-8');
    });
    DOM.on(rootEl, 'click', '[data-action="exp-batches"]', function () {
      DOM.download('批次汇总_' + U.todayString() + '.csv', store.exportBatchesCSV(), 'text/csv;charset=utf-8');
    });

    DOM.on(rootEl, 'click', '[data-action="del-batch"]', function (e, btn) {
      var info = store.getBatchInfo(btn.dataset.id);
      if (!info) return;
      DOM.confirm({
        title: '撤销这一批',
        content: '将删除该批次的全部记录（' + info.count + ' 人，合计 ' + U.money(info.totalAmountFen) +
          '）：' + info.studentNames.join('、'),
        okText: '撤销'
      }).then(function (ok) {
        if (!ok) return;
        store.deleteBatch(btn.dataset.id);
        DOM.toast('已撤销该批次', 'success');
        app.refresh();
      });
    });
  }

  P.UI.Stats = { render: render, mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);