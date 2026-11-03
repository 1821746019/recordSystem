/*!
 * ui/students.js —— 学生页（档案管理 / 欠款看板 / 一键结清 / 最近记录）
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem = root.PrintSystem || {};
  var U = P.Utils;
  var DOM = P.UI.DOM;
  var Actions = P.UI.Actions;

  var SORTS = [
    { key: 'unpaid', label: '按未结清' },
    { key: 'amount', label: '按消费额' },
    { key: 'name', label: '按姓名' },
    { key: 'recent', label: '按最近打印' }
  ];

  function render(ctx) {
    var state = ctx.state.students;
    var store = ctx.store;
    var students = store.listStudents(state.keyword);
    var rows = students.map(function (s) {
      var st = store.studentStats(s.id);
      st.student = s;
      return st;
    });

    var sortFn = {
      unpaid: function (a, b) { return b.unpaidFen - a.unpaidFen || U.compareName(a.student.name, b.student.name); },
      amount: function (a, b) { return b.amountFen - a.amountFen || U.compareName(a.student.name, b.student.name); },
      name: function (a, b) { return U.compareName(a.student.name, b.student.name); },
      recent: function (a, b) { return (b.lastDate || '').localeCompare(a.lastDate || ''); }
    }[state.sort] || null;
    if (sortFn) rows.sort(sortFn);

    var totalUnpaid = U.sum(rows, function (r) { return r.unpaidFen; });
    var unpaidCount = rows.filter(function (r) { return r.unpaidFen > 0; }).length;

    var html = '';

    /* 顶部工具 */
    html += '<section class="card">';
    html += '  <div class="search-row">';
    html += '    <input class="input" id="s-keyword" type="search" placeholder="姓名 / 拼音 / 首字母 / 班级 / 学号" value="' + DOM.esc(state.keyword) + '">';
    html += '    <button type="button" class="btn btn-primary btn-sm" data-action="add">＋ 新建</button>';
    html += '  </div>';
    html += '  <div class="chips">' + SORTS.map(function (s) {
      return '<button type="button" class="chip' + (state.sort === s.key ? ' active' : '') +
        '" data-action="sort" data-key="' + s.key + '">' + s.label + '</button>';
    }).join('') + '</div>';
    html += '  <div class="filter-summary">共 ' + rows.length + ' 名学生 · 未结清 ' +
      '<b class="warn">' + U.money(totalUnpaid) + '</b>（' + unpaidCount + ' 人）</div>';
    html += '</section>';

    /* 学生列表 */
    if (!rows.length) {
      html += '<div class="empty"><div class="empty-icon">🧑‍🎓</div><div>还没有学生</div>' +
        '<div class="hint">点右上角「＋ 新建」添加</div></div>';
    }

    rows.forEach(function (st) {
      var s = st.student;
      var opened = !!state.expanded[s.id];
      html += '<article class="student-card' + (st.unpaidFen > 0 ? ' has-unpaid' : '') + '" data-id="' + s.id + '">';
      html += '  <div class="sc-head">';
      html += '    <div class="sc-id">';
      html += '      <div class="sc-name">' + DOM.esc(s.name) + '</div>';
      html += '      <div class="sc-meta">' + (s.className ? DOM.esc(s.className) : '未填班级') +
        (s.studentNo ? ' · ' + DOM.esc(s.studentNo) : '') + '</div>';
      html += '    </div>';
      html += '    <div class="sc-money">';
      if (st.unpaidFen > 0) {
        html += '      <div class="sc-unpaid">未结清 ' + U.money(st.unpaidFen) + '</div>';
        html += '      <div class="sc-sub">' + st.unpaidCount + ' 条待结</div>';
      } else if (st.recordCount > 0) {
        html += '      <div class="sc-paid">已结清 ✓</div>';
        html += '      <div class="sc-sub">共 ' + st.recordCount + ' 条</div>';
      } else {
        html += '      <div class="sc-sub">暂无记录</div>';
      }
      html += '    </div>';
      html += '  </div>';

      html += '  <div class="sc-stats">';
      html += '    <span>累计 <b>' + U.money(st.amountFen) + '</b></span>';
      html += '    <span>' + U.qty(st.sheets) + ' 张</span>';
      if (st.lastDate) html += '    <span>最近 ' + DOM.esc(U.formatDateHuman(st.lastDate)) + '</span>';
      html += '  </div>';

      html += '  <div class="sc-ops">';
      if (st.unpaidFen > 0) {
        html += '    <button type="button" class="mini-btn primary" data-action="settle-all">结清全部 ' + U.money(st.unpaidFen) + '</button>';
      }
      html += '    <button type="button" class="mini-btn" data-action="detail">' + (opened ? '收起' : '明细') + '</button>';
      html += '    <button type="button" class="mini-btn" data-action="records">查看记录</button>';
      html += '    <button type="button" class="mini-btn" data-action="edit">编辑</button>';
      html += '    <button type="button" class="mini-btn danger" data-action="del">删除</button>';
      html += '  </div>';

      if (opened) {
        var recs = store.queryRecords({ studentId: s.id, limit: 20 });
        html += '  <div class="sc-detail">';
        html += '    <div class="detail-title">最近打印（最多 20 条）</div>';
        if (!recs.length) {
          html += '    <div class="hint">暂无打印记录</div>';
        } else {
          html += '    <div class="mini-list">';
          recs.forEach(function (r) {
            html += '<div class="mini-row">' +
              '<span>' + DOM.esc(U.formatDateHuman(r.date)) + '</span>' +
              '<span>' + U.qty(r.sheets) + ' 张' + (r.note ? ' · ' + DOM.esc(r.note) : '') + '</span>' +
              '<span class="' + (r.paymentId ? 'ok' : 'warn') + '">' + U.money(r.amountFen) + (r.paymentId ? ' 已结' : '') + '</span>' +
              '</div>';
          });
          html += '    </div>';
        }
        if (st.paymentCount > 0) {
          html += '    <div class="hint">已收款 ' + U.money(st.receivedFen) + ' · ' + st.paymentCount + ' 笔</div>';
        }
        html += '  </div>';
      }
      html += '</article>';
    });

    return html;
  }

  function mount(ctx, rootEl) {
    var state = ctx.state.students;
    var store = ctx.store;
    var app = ctx.app;

    DOM.on(rootEl, 'input', '#s-keyword', function (e, el) {
      state.keyword = el.value;
      app.refresh();
      // 重绘后容器是新的，要从当前页面重新取输入框，保持焦点与光标位置
      var next = DOM.qs('#s-keyword');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    });

    DOM.on(rootEl, 'click', '[data-action="sort"]', function (e, btn) {
      state.sort = btn.dataset.key;
      app.refresh();
    });

    DOM.on(rootEl, 'click', '[data-action="add"]', function () {
      Actions.openStudentEdit(ctx, null);
    });

    DOM.on(rootEl, 'click', '[data-action="detail"]', function (e, btn) {
      var id = btn.closest('.student-card').dataset.id;
      state.expanded[id] = !state.expanded[id];
      app.refresh();
    });

    DOM.on(rootEl, 'click', '[data-action="edit"]', function (e, btn) {
      var id = btn.closest('.student-card').dataset.id;
      Actions.openStudentEdit(ctx, store.getStudent(id));
    });

    DOM.on(rootEl, 'click', '[data-action="records"]', function (e, btn) {
      var id = btn.closest('.student-card').dataset.id;
      var stu = store.getStudent(id);
      if (!stu) return;
      var rs = ctx.state.records;
      rs.keyword = stu.name;
      rs.from = '';
      rs.to = '';
      rs.range = 'all';
      rs.status = 'all';
      rs.selected = [];
      app.go('records');
    });

    DOM.on(rootEl, 'click', '[data-action="settle-all"]', function (e, btn) {
      var id = btn.closest('.student-card').dataset.id;
      var st = store.studentStats(id);
      var recs = store.getState().records.filter(function (r) {
        return r.studentId === id && !r.paymentId;
      });
      if (!recs.length) { DOM.toast('该学生没有未结清记录', 'error'); return; }
      Actions.openSettle(ctx, recs, { studentId: id });
    });

    DOM.on(rootEl, 'click', '[data-action="del"]', function (e, btn) {
      var id = btn.closest('.student-card').dataset.id;
      var stu = store.getStudent(id);
      if (!stu) return;
      var st = store.studentStats(id);

      DOM.openModal({
        title: '删除学生',
        okText: '删除',
        content:
          '<div class="form">' +
            '<p class="confirm-text">确定删除学生「' + DOM.esc(stu.name) + '」吗？</p>' +
            (st.recordCount > 0
              ? '<label class="ck-inline"><input type="checkbox" id="f-delrec"> 同时删除 TA 的 ' +
                st.recordCount + ' 条打印记录（不可恢复）</label>' +
                '<div class="hint">不勾选则只删除学生档案，历史打印记录会保留（记录里仍能看到姓名）。</div>'
              : '<div class="hint">该学生还没有打印记录。</div>') +
          '</div>',
        onOk: function (rootEl2) {
          var delRec = DOM.qs('#f-delrec', rootEl2);
          try {
            store.deleteStudent(id, { deleteRecords: !!(delRec && delRec.checked) });
            DOM.toast('已删除学生', 'success');
            app.refresh();
          } catch (err) {
            DOM.toast(err.message || '删除失败', 'error');
            return false;
          }
          return true;
        }
      });
    });
  }

  P.UI.Students = { render: render, mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);