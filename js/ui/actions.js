/*!
 * ui/actions.js —— 公共操作弹窗（编辑记录 / 收款结算 / 学生档案）
 * 记录页、学生页、统计页都复用这里的逻辑，避免重复代码。
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem = root.PrintSystem || {};
  var U = P.Utils;
  var DOM = P.UI.DOM;

  function studentOptions(students, selectedId) {
    return students.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === selectedId ? ' selected' : '') + '>' +
        DOM.esc(s.name + (s.className ? '（' + s.className + '）' : '')) + '</option>';
    }).join('');
  }

  /* ---------------------- 学生档案：新增 / 编辑 ---------------------- */

  function openStudentEdit(ctx, student) {
    var store = ctx.store;
    var isEdit = !!student;
    var s = student || { name: '', className: '', studentNo: '', phone: '', note: '' };

    DOM.openModal({
      title: isEdit ? '编辑学生' : '新建学生',
      okText: isEdit ? '保存' : '创建',
      content:
        '<div class="form">' +
          '<label class="field"><span>姓名 <i class="req">*</i></span>' +
            '<input class="input" id="f-name" type="text" value="' + DOM.esc(s.name) + '" placeholder="必填"></label>' +
          '<div class="grid2">' +
            '<label class="field"><span>班级</span>' +
              '<input class="input" id="f-class" type="text" value="' + DOM.esc(s.className) + '" placeholder="如 高一(3)班"></label>' +
            '<label class="field"><span>学号</span>' +
              '<input class="input" id="f-no" type="text" value="' + DOM.esc(s.studentNo) + '" placeholder="选填"></label>' +
          '</div>' +
          '<label class="field"><span>电话 / 微信</span>' +
            '<input class="input" id="f-phone" type="text" value="' + DOM.esc(s.phone) + '" placeholder="选填"></label>' +
          '<label class="field"><span>备注</span>' +
            '<input class="input" id="f-note" type="text" value="' + DOM.esc(s.note) + '" placeholder="选填"></label>' +
        '</div>',
      onOk: function (rootEl) {
        var data = {
          name: DOM.qs('#f-name', rootEl).value,
          className: DOM.qs('#f-class', rootEl).value,
          studentNo: DOM.qs('#f-no', rootEl).value,
          phone: DOM.qs('#f-phone', rootEl).value,
          note: DOM.qs('#f-note', rootEl).value
        };
        try {
          if (isEdit) {
            store.updateStudent(student.id, data);
            DOM.toast('已保存', 'success');
          } else {
            var created = store.addStudent(data);
            DOM.toast('已创建学生：' + created.name, 'success');
          }
          ctx.app.refresh();
        } catch (err) {
          DOM.toast(err.message || '保存失败', 'error');
          return false;
        }
        return true;
      }
    });
  }

  /* ---------------------- 打印记录：编辑 ---------------------- */

  function openRecordEdit(ctx, record) {
    var store = ctx.store;
    var students = store.listStudents('');
    if (!store.getStudent(record.studentId) && record.studentId) {
      // 学生已被删除，补一个占位项
      students = [{ id: record.studentId, name: (record.studentName || '（已删除）') + '（已删除）', className: '' }].concat(students);
    }

    DOM.openModal({
      title: '编辑打印记录',
      content:
        '<div class="form">' +
          '<label class="field"><span>学生</span><select class="input" id="f-student">' +
            studentOptions(students, record.studentId) + '</select></label>' +
          '<div class="grid2">' +
            '<label class="field"><span>日期</span><input class="input" type="date" id="f-date" value="' + DOM.esc(record.date) + '"></label>' +
            '<label class="field"><span>时间</span><input class="input" type="time" id="f-time" value="' + DOM.esc(record.time) + '"></label>' +
          '</div>' +
          '<div class="grid2">' +
          '</div>' +
          '<label class="field"><span>张数</span><input class="input" type="number" min="0" step="0.5" id="f-sheets" value="' + U.qty(record.sheets) + '"></label>' +
          '<label class="field"><span>内容 / 备注</span><input class="input" type="text" id="f-note" value="' + DOM.esc(record.note) + '"></label>' +
          '<div class="hint">金额按这条记录当时冻结的单价重算：' +
            U.fenToYuan(record.priceFen) + ' 元/张（单双面同价）' +
            (record.paymentId ? '。<br>注意：该记录已结清，修改金额后请自行确认收款是否一致。' : '') + '</div>' +
        '</div>',
      onOk: function (rootEl) {
        try {
          store.updateRecord(record.id, {
            studentId: DOM.qs('#f-student', rootEl).value,
            date: DOM.qs('#f-date', rootEl).value,
            time: DOM.qs('#f-time', rootEl).value,
            sheets: U.clampInt(DOM.qs('#f-sheets', rootEl).value, 0, P.Pricing.MAX_SHEETS),
            note: DOM.qs('#f-note', rootEl).value
          });
          DOM.toast('已更新记录', 'success');
          ctx.app.refresh();
        } catch (err) {
          DOM.toast(err.message || '保存失败', 'error');
          return false;
        }
        return true;
      }
    });
  }

  /* ---------------------- 收款结算 ---------------------- */

  /**
   * @param {Array} records 要结算的记录（未结清的）
   * @param {Object} opts { studentId }
   */
  function openSettle(ctx, records, opts) {
    opts = opts || {};
    var store = ctx.store;
    var pending = (records || []).filter(function (r) { return !r.paymentId; });
    if (!pending.length) {
      DOM.toast('没有可结算的记录', 'error');
      return;
    }
    var shouldFen = U.sum(pending, function (r) { return r.amountFen; });
    var studentId = opts.studentId || pending[0].studentId;
    var student = store.getStudent(studentId);
    var names = student ? student.name : (pending[0].studentName || '');

    var listHtml = pending.slice(0, 30).map(function (r) {
      return '<div class="mini-row"><span>' + DOM.esc(U.formatDateHuman(r.date)) + '</span>' +
        '<span>' + U.qty(r.sheets) + ' 张</span>' +
        '<span>' + U.money(r.amountFen) + '</span></div>';
    }).join('') + (pending.length > 30 ? '<div class="hint">… 还有 ' + (pending.length - 30) + ' 条</div>' : '');

    DOM.openModal({
      title: '收款结算',
      okText: '确认收款',
      content:
        '<div class="form">' +
          '<div class="settle-head">' +
            '<div class="settle-name">' + DOM.esc(names) + '</div>' +
            '<div class="settle-sum">共 ' + pending.length + ' 条记录 · 应收 ' +
              '<b id="f-should">' + U.money(shouldFen) + '</b></div>' +
          '</div>' +
          '<div class="mini-list">' + listHtml + '</div>' +
          '<label class="field"><span>实收金额（元）</span>' +
            '<input class="input" id="f-amount" type="number" step="0.01" min="0" value="' + U.fenToYuan(shouldFen) + '"></label>' +
          '<div class="hint" id="f-diff"></div>' +
          '<div class="grid2">' +
            '<label class="field"><span>收款方式</span><select class="input" id="f-method">' +
              store.PAY_METHODS.map(function (m) {
                return '<option value="' + m + '">' + m + '</option>';
              }).join('') +
            '</select></label>' +
            '<label class="field"><span>收款日期</span><input class="input" type="date" id="f-date" value="' + U.todayString() + '"></label>' +
          '</div>' +
          '<label class="field"><span>备注</span><input class="input" type="text" id="f-note" placeholder="选填，例如：优惠抹零"></label>' +
        '</div>',
      onOpen: function (rootEl) {
        var amountInput = DOM.qs('#f-amount', rootEl);
        var diffEl = DOM.qs('#f-diff', rootEl);
        function updateDiff() {
          var got = U.yuanToFen(amountInput.value);
          var diff = shouldFen - got;
          if (diff > 0) diffEl.innerHTML = '少收 <b class="warn">' + U.money(diff) + '</b>（将记为优惠）';
          else if (diff < 0) diffEl.innerHTML = '多收 <b class="warn">' + U.money(-diff) + '</b>（可能是预存/找零，请确认）';
          else diffEl.innerHTML = '与应收金额一致';
        }
        amountInput.addEventListener('input', updateDiff);
        updateDiff();
      },
      onOk: function (rootEl) {
        try {
          var payment = store.settleRecords(pending.map(function (r) { return r.id; }), {
            studentId: studentId,
            amountFen: U.yuanToFen(DOM.qs('#f-amount', rootEl).value),
            method: DOM.qs('#f-method', rootEl).value,
            date: DOM.qs('#f-date', rootEl).value,
            note: DOM.qs('#f-note', rootEl).value
          });
          DOM.toast('已收款 ' + U.money(payment.amountFen) + '，' + pending.length + ' 条记录已结清', 'success', 2600);
          ctx.app.refresh();
        } catch (err) {
          DOM.toast(err.message || '结算失败', 'error');
          return false;
        }
        return true;
      }
    });
  }

  /* ---------------------- 删除确认 ---------------------- */

  function confirmDeleteRecords(ctx, records) {
    var count = records.length;
    var amount = U.sum(records, function (r) { return r.amountFen; });
    return DOM.confirm({
      title: '删除记录',
      content: '确定删除这 ' + count + ' 条打印记录（合计 ' + U.money(amount) + '）吗？删除后无法恢复。',
      okText: '删除'
    }).then(function (ok) {
      if (!ok) return false;
      ctx.store.deleteRecords(records.map(function (r) { return r.id; }));
      DOM.toast('已删除 ' + count + ' 条记录', 'success');
      ctx.app.refresh();
      return true;
    });
  }

  P.UI.Actions = {
    openStudentEdit: openStudentEdit,
    openRecordEdit: openRecordEdit,
    openSettle: openSettle,
    confirmDeleteRecords: confirmDeleteRecords,
    studentOptions: studentOptions
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);