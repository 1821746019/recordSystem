/*!
 * ui/settings.js —— 设置页（单价 / 名称 / 数据备份恢复 / 清空）
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem = root.PrintSystem || {};
  var U = P.Utils;
  var DOM = P.UI.DOM;

  function render(ctx) {
    var store = ctx.store;
    var s = store.getSettings();
    var html = '';

    /* 计价设置 */
    html += '<section class="card">';
    html += '  <div class="card-title">计价设置</div>';
    html += '  <label class="field"><span>打印单价（元 / 张）</span>' +
      '<input class="input" id="set-price" type="number" step="0.01" min="0" inputmode="decimal" value="' + U.fenToYuan(s.priceFen) + '"></label>';
    html += '  <div class="hint" id="set-preview"></div>';
    html += '  <button type="button" class="btn btn-primary" data-action="save-price">保存单价</button>';
    html += '  <div class="hint">统一按这个价算：<b>金额 = 张数 × 单价</b>。' +
      '改价只影响之后的新记录，历史记录会保留当时的价格，不会被改写。</div>';
    html += '</section>';

    /* 基本信息 */
    html += '<section class="card">';
    html += '  <div class="card-title">基本设置</div>';
    html += '  <label class="field"><span>系统 / 店铺名称</span>' +
      '<input class="input" id="set-shop" type="text" value="' + DOM.esc(s.shopName) + '" placeholder="例如：文印室打印记录"></label>';
    html += '  <label class="field"><span>操作人</span>' +
      '<input class="input" id="set-operator" type="text" value="' + DOM.esc(s.operator) + '" placeholder="选填"></label>';
    html += '  <button type="button" class="btn btn-primary" data-action="save-basic">保存</button>';
    html += '</section>';

    /* 数据管理 */
    html += '<section class="card">';
    html += '  <div class="card-title">数据管理</div>';
    html += '  <div class="btn-row">';
    html += '    <button type="button" class="btn btn-soft" data-action="backup">备份为 JSON</button>';
    html += '    <button type="button" class="btn btn-soft" data-action="restore">从 JSON 恢复</button>';
    html += '    <button type="button" class="btn btn-soft" data-action="demo">载入示例数据</button>';
    html += '    <button type="button" class="btn btn-danger-ghost" data-action="clear">清空业务数据</button>';
    html += '    <button type="button" class="btn btn-danger-ghost" data-action="reset">恢复出厂设置</button>';
    html += '  </div>';
    html += '  <div class="hint">数据保存在本机浏览器（localStorage），换设备 / 清缓存前请先「备份为 JSON」。</div>';
    html += '</section>';

    /* 关于 */
    var st = store.getState();
    html += '<section class="card">';
    html += '  <div class="card-title">关于</div>';
    html += '  <div class="about">';
    html += '    <div>存储方式：<b>' + DOM.esc(store.storageName) + '</b>（key: ' + DOM.esc(store.storageKey) + '）</div>';
    html += '    <div>数据版本：v' + DOM.esc(store.SCHEMA_VERSION) + '</div>';
    html += '    <div>现有数据：' + st.students.length + ' 名学生 / ' + st.records.length + ' 条记录 / ' +
      st.payments.length + ' 笔收款</div>';
    html += '    <div class="hint">核心逻辑（js/core/）不含任何界面代码，可原样迁移到微信小程序，' +
      '只需把存储适配器换成 wx.getStorageSync / wx.setStorageSync。</div>';
    html += '  </div>';
    html += '</section>';

    return html;
  }

  function mount(ctx, rootEl) {
    var store = ctx.store;
    var app = ctx.app;

    function preview() {
      var p = P.Pricing.normalize({ priceFen: U.yuanToFen(DOM.qs('#set-price', rootEl).value) });
      var demo = P.Pricing.calculateBatch(5, { sheets: 5 }, p);
      DOM.qs('#set-preview', rootEl).textContent =
        '示例：每人 5 张 × ' + U.fenToYuan(p.priceFen) + ' 元/张 = 每人 ' + U.money(demo.perAmountFen) +
        '；若一次给 5 名学生记，合计 ' + U.money(demo.totalAmountFen);
    }
    DOM.on(rootEl, 'input', '#set-price', preview);
    preview();

    DOM.on(rootEl, 'click', '[data-action="save-price"]', function () {
      var price = U.yuanToFen(DOM.qs('#set-price', rootEl).value);
      if (price <= 0) {
        DOM.toast('单价必须大于 0', 'error');
        return;
      }
      store.updateSettings({ priceFen: price });
      DOM.toast('单价已保存：' + U.fenToYuan(price) + ' 元/张', 'success');
      app.refresh();
    });

    DOM.on(rootEl, 'click', '[data-action="save-basic"]', function () {
      store.updateSettings({
        shopName: DOM.qs('#set-shop', rootEl).value,
        operator: DOM.qs('#set-operator', rootEl).value
      });
      DOM.toast('已保存', 'success');
      app.refresh();
    });

    DOM.on(rootEl, 'click', '[data-action="backup"]', function () {
      DOM.download('打印记录备份_' + U.todayString() + '.json', store.exportJSON(), 'application/json');
      DOM.toast('已生成备份文件', 'success');
    });

    DOM.on(rootEl, 'click', '[data-action="restore"]', function () {
      DOM.pickTextFile('.json,application/json').then(function (file) {
        var data;
        try {
          data = JSON.parse(file.text);
        } catch (e) {
          DOM.toast('文件不是合法的 JSON', 'error');
          return;
        }
        var preview = P.Store.normalizeState(data);
        DOM.openModal({
          title: '恢复数据',
          okText: '确认导入',
          content:
            '<div class="form">' +
              '<p class="confirm-text">文件：' + DOM.esc(file.name) + '</p>' +
              '<div class="mini-list">' +
                '<div class="mini-row"><span>学生</span><span></span><span>' + preview.students.length + ' 人</span></div>' +
                '<div class="mini-row"><span>打印记录</span><span></span><span>' + preview.records.length + ' 条</span></div>' +
                '<div class="mini-row"><span>收款记录</span><span></span><span>' + preview.payments.length + ' 笔</span></div>' +
              '</div>' +
              '<label class="field"><span>导入方式</span><select class="input" id="f-mode">' +
                '<option value="replace">覆盖：清空现有数据后导入</option>' +
                '<option value="merge">合并：保留现有数据，追加不重复的部分</option>' +
              '</select></label>' +
              '<div class="hint">覆盖方式不可撤销，建议先「备份为 JSON」。</div>' +
            '</div>',
          onOk: function (rootEl2) {
            try {
              var stats = store.importJSON(preview, { mode: DOM.qs('#f-mode', rootEl2).value });
              DOM.toast('导入完成：' + stats.students + ' 学生 / ' + stats.records + ' 记录', 'success', 2600);
              app.refresh();
            } catch (err) {
              DOM.toast(err.message || '导入失败', 'error');
              return false;
            }
            return true;
          }
        });
      }).catch(function (err) {
        if (err && err.message !== '未选择文件') DOM.toast(err.message || '读取失败', 'error');
      });
    });

    DOM.on(rootEl, 'click', '[data-action="demo"]', function () {
      DOM.confirm({
        title: '载入示例数据',
        content: '会新增 4 名学生和 6 条示例记录（不影响现有数据）。继续吗？'
      }).then(function (ok) {
        if (!ok) return;
        store.seedDemoData();
        DOM.toast('示例数据已载入', 'success');
        app.go('quick');
      });
    });

    DOM.on(rootEl, 'click', '[data-action="clear"]', function () {
      DOM.confirm({
        title: '清空业务数据',
        content: '将删除全部学生、打印记录和收款记录（设置会保留）。此操作不可恢复，建议先备份。',
        okText: '确认清空'
      }).then(function (ok) {
        if (!ok) return;
        store.clearData();
        DOM.toast('已清空', 'success');
        app.go('quick');
      });
    });

    DOM.on(rootEl, 'click', '[data-action="reset"]', function () {
      DOM.confirm({
        title: '恢复出厂设置',
        content: '将清空所有数据并把单价恢复为 0.20 / 0.30。此操作不可恢复！',
        okText: '确认重置'
      }).then(function (ok) {
        if (!ok) return;
        store.reset();
        DOM.toast('已恢复出厂设置', 'success');
        app.refresh();
      });
    });
  }

  P.UI.Settings = { render: render, mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);