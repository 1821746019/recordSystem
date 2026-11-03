/*!
 * ui/quick.js —— 记账页（批量版）
 * ---------------------------------------------------------------
 * 流程：① 选学生：搜索框里可以连续输入多个「姓名 / 拼音首字母」，用逗号分隔，
 *          输入 `zzh,zqy` 就会自动勾选对应学生；也可以手动点候选列表
 *       ② 填写这一批统一打印多少张（支持半张，0.5 粒度）
 *       ③ 实时显示「每人多少钱 × N 人 = 合计多少钱」→ 保存
 * 保存后每个学生各生成一条独立记录（共享一个批次号，可整批撤销）。
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem = root.PrintSystem || {};
  var U = P.Utils;
  var DOM = P.UI.DOM;

  var CHIPS = [0.5, 1, 2, 5, 10, 20];   // 张数快捷值（含半张）
  var STEP = 0.5;                        // 步进粒度：半张

  var AUTO_MIN_LEN = 2;      // 分隔词至少 2 个字符才自动勾选（避免输一个字母就选中一大片）
  var AUTO_MIN_SCORE = 66;   // 只认较靠谱的匹配（过滤掉「全拼中间片段」这类很松的命中）

  /**
   * 分隔符：半角/全角逗号、分号、顿号、斜杠、竖线、换行。
   * 故意**不含空格**——空格仍然是「同一个人」的多关键字（如 `zxm 高一`）。
   */
  var SEP = /[,，;；、\/|\n]+/;

  /** 把搜索框内容切成多个词 */
  function splitTokens(text) {
    return String(text == null ? '' : text).split(SEP)
      .map(function (t) { return U.trim(t); })
      .filter(Boolean);
  }

  /** 正在输入的最后一段（候选列表按它过滤） */
  function lastToken(text) {
    var parts = String(text == null ? '' : text).split(SEP);
    return U.trim(parts[parts.length - 1] || '');
  }

  /* ------------------------- 片段 ------------------------- */

  function counter(field, label, icon, value) {
    return '' +
      '<div class="counter" data-field="' + field + '">' +
        '<div class="counter-label">' + icon + ' ' + label + '</div>' +
        '<div class="counter-ctrl">' +
          '<button type="button" class="step" data-action="step" data-field="' + field + '" data-delta="-' + STEP + '">−</button>' +
          '<input class="counter-input" id="q-' + field + '" type="number" inputmode="decimal" min="0" step="' + STEP + '" ' +
            'data-field="' + field + '" value="' + P.Pricing.qty(value) + '">' +
          '<button type="button" class="step" data-action="step" data-field="' + field + '" data-delta="' + STEP + '">+</button>' +
        '</div>' +
      '</div>';
  }

  function chips(field) {
    return '<div class="chips chips-sm">' +
      CHIPS.map(function (n) {
        return '<button type="button" class="chip" data-action="chip" data-field="' + field +
          '" data-value="' + n + '">' + P.Pricing.qty(n) + '</button>';
      }).join('') +
      '<button type="button" class="chip chip-reset" data-action="chip" data-field="' + field + '" data-value="0">清零</button>' +
      '</div>';
  }

  /** 已选学生区域（chips），显示在搜索框下方 */
  function pickedHTML(ctx) {
    var s = ctx.state.quick;
    var store = ctx.store;
    var students = s.selectedIds.map(function (id) { return store.getStudent(id); }).filter(Boolean);
    if (!students.length) {
      return '<div class="hint">还没选学生。可输入姓名 / 拼音首字母，用 <b>,</b> 分隔一次输入多个（如 zzh,zqy）。</div>';
    }
    return '<div class="picked">' + students.map(function (st) {
      return '<span class="pick-chip">' + DOM.esc(st.name) +
        '<button type="button" class="pick-x" data-action="unpick" data-id="' + st.id + '" aria-label="移除">✕</button>' +
        '</span>';
    }).join('') + '</div>';
  }

  /** 已选学生的账目提示 */
  function selectedHint(ctx) {
    var s = ctx.state.quick;
    var store = ctx.store;
    var ids = s.selectedIds;
    if (!ids.length) {
      var total = store.listStudents('').length;
      var tip = store.pinyinMode === 'full'
        ? '支持逗号批量勾选（输入 zzh,zqy 自动选中）'
        : '用逗号分隔可一次输入多个名字';
      return '共 ' + total + ' 名学生 · ' + tip + ' · 也可直接点候选列表';
    }
    var unpaidFen = 0, unpaidPeople = 0, amountFen = 0;
    ids.forEach(function (id) {
      var st = store.studentStats(id);
      amountFen += st.amountFen;
      if (st.unpaidFen > 0) { unpaidFen += st.unpaidFen; unpaidPeople++; }
    });
    return '已选 ' + ids.length + ' 人 · 未结清合计 ' + U.money(unpaidFen) +
      (unpaidPeople ? '（' + unpaidPeople + ' 人）' : '') +
      ' · 历史累计 ' + U.money(amountFen);
  }

  /* ------------------------- 渲染 ------------------------- */

  function render(ctx) {
    var s = ctx.state.quick;
    var store = ctx.store;
    var pricing = store.getPricing();
    var people = s.selectedIds.length;
    var batch = P.Pricing.calculateBatch(people, s, pricing);
    var html = '';

    /* ① 选学生（多选） */
    html += '<section class="card">';
    html += '  <div class="card-title">① 选择学生' +
      (people ? '<span class="count-badge">已选 ' + people + ' 人</span>' : '') + '</div>';
    html += '  <div class="combo" id="q-combo">';
    html += '    <input class="input combo-input" id="q-search" type="text" autocomplete="off" ' +
      'placeholder="姓名 / 拼音首字母，用 , 分隔可批量选中（zzh,zqy）" value="' + DOM.esc(s.search) + '">';
    html += '    <button type="button" class="combo-clear" id="q-search-clear" title="清空搜索">✕</button>';
    html += '    <div class="combo-list" id="q-list" hidden></div>';
    html += '  </div>';
    html += '  <div id="q-picked">' + pickedHTML(ctx) + '</div>';
    html += '  <div class="hint" id="q-hint">' + DOM.esc(selectedHint(ctx)) + '</div>';
    html += '</section>';

    /* ② 张数（整批统一） */
    html += '<section class="card">';
    html += '  <div class="card-title">② 每人打印了多少张</div>';
    html += counter('sheets', '张数', '🖨️', s.sheets);
    html += chips('sheets');
    html += '  <div class="hint">这一批学生共用同样的张数（支持半张 0.5）。单价 ' +
      U.fenToYuan(pricing.priceFen) + ' 元/张，金额 = 张数 × 单价。</div>';
    html += '</section>';

    /* ③ 金额 */
    html += '<section class="card amount-card">';
    html += '  <div class="amount-label">每人 ' + U.money(batch.perAmountFen) + ' × ' + people + ' 人</div>';
    html += '  <div class="amount" id="q-amount">' + U.money(batch.totalAmountFen) + '</div>';
    html += '  <div class="amount-sub" id="q-detail">' + P.Pricing.breakdown(s, pricing) + '</div>';
    html += '  <div class="amount-sub" id="q-counts">' +
      (people ? '共 ' + U.qty(batch.sheets * people) + ' 张（每人 ' + U.qty(batch.sheets) + ' 张）' : '请先选择学生') + '</div>';
    html += '</section>';

    /* ④ 其它信息 */
    html += '<section class="card">';
    html += '  <div class="card-title">③ 补充信息（可不填）</div>';
    html += '  <div class="grid2">';
    html += '    <label class="field"><span>日期</span><input class="input" type="date" id="q-date" value="' + DOM.esc(s.date) + '"></label>';
    html += '    <label class="field"><span>时间</span><input class="input" type="time" id="q-time" value="' + DOM.esc(s.time) + '"></label>';
    html += '  </div>';
    html += '  <label class="field"><span>内容 / 备注（整批共用）</span>' +
      '<input class="input" type="text" id="q-note" placeholder="例如：数学周测卷 全班统一" value="' + DOM.esc(s.note) + '"></label>';
    html += '</section>';

    /* ⑤ 操作 */
    html += '<div class="action-bar">';
    html += '  <button type="button" class="btn btn-primary btn-lg" data-action="save">' +
      '保存记录' + (people > 1 ? '（' + people + ' 人）' : '') + '</button>';
    html += '  <button type="button" class="btn btn-soft" data-action="save-clear">保存并清空</button>';
    html += '</div>';

    /* ⑥ 撤销上一批 */
    if (s.lastBatchId) {
      html += '<div class="undo-bar">';
      html += '  <span>上一批：' + s.lastBatchCount + ' 人 · ' + U.money(s.lastBatchTotalFen) + '</span>';
      html += '  <button type="button" class="mini-btn danger" data-action="undo-batch">撤销这一批</button>';
      html += '</div>';
    }

    return html;
  }

  /* ------------------------- 交互 ------------------------- */

  function mount(ctx, rootEl) {
    var s = ctx.state.quick;
    var app = ctx.app;
    var store = ctx.store;

    // 兜底：state 可能来自旧版本 / 外部构造，缺字段会让下面炸掉
    s.selectedIds = s.selectedIds || [];
    s.autoMap = s.autoMap || {};
    s.excluded = s.excluded || [];

    var searchInput = DOM.qs('#q-search', rootEl);
    var listEl = DOM.qs('#q-list', rootEl);
    var pickedEl = DOM.qs('#q-picked', rootEl);
    var hintEl = DOM.qs('#q-hint', rootEl);

    function isSelected(id) { return s.selectedIds.indexOf(id) >= 0; }

    /* ---------- 顶部数字：金额 / 张数 / 人数 ---------- */
    function updateCalc() {
      var pricing = store.getPricing();
      var people = s.selectedIds.length;
      var batch = P.Pricing.calculateBatch(people, s, pricing);
      var amountEl = DOM.qs('#q-amount', rootEl);
      var detailEl = DOM.qs('#q-detail', rootEl);
      var countsEl = DOM.qs('#q-counts', rootEl);
      if (amountEl) amountEl.textContent = U.money(batch.totalAmountFen);
      if (detailEl) detailEl.textContent = P.Pricing.breakdown(s, pricing);
      if (countsEl) {
        countsEl.textContent = people
          ? '共 ' + U.qty(batch.sheets * people) + ' 张（每人 ' + U.qty(batch.sheets) + ' 张）'
          : '请先选择学生';
      }

      // ★ 把最新张数写回输入框。
      //   之前漏了这一步：点「＋/−」或快捷数字时只更新了金额，输入框还显示旧值。
      //   （如果用户正在输入框里打字，就不要回写，免得光标乱跳）
      var inputEl = DOM.qs('#q-sheets', rootEl);
      var active = (typeof document !== 'undefined' && document.activeElement) || null;
      if (inputEl && inputEl !== active && String(inputEl.value) !== String(s.sheets)) {
        inputEl.value = s.sheets;
      }

      var labelEl = DOM.qs('.amount-label', rootEl);
      if (labelEl) labelEl.textContent = '每人 ' + U.money(batch.perAmountFen) + ' × ' + people + ' 人';

      // ★ 保存按钮的人数：必须跟着「当前选择」实时变。
      //   之前只在整页重绘时更新，导致勾选/取消后按钮还显示上一次的数字
      //   （看起来就像"上次保存时的人数"）。
      var saveBtn = DOM.qs('[data-action="save"]', rootEl);
      if (saveBtn) saveBtn.textContent = '保存记录' + (people > 1 ? '（' + people + ' 人）' : '');

      // 标题旁的人数徽标同理：有人时显示，没人时移除
      var badge = DOM.qs('.count-badge', rootEl);
      if (people > 0) {
        if (badge) {
          badge.textContent = '已选 ' + people + ' 人';
        } else {
          var title = DOM.qs('.card-title', rootEl);
          if (title) title.insertAdjacentHTML('beforeend', '<span class="count-badge">已选 ' + people + ' 人</span>');
        }
      } else if (badge) {
        if (badge.parentNode && badge.parentNode.removeChild) badge.parentNode.removeChild(badge);
        else badge.textContent = '';
      }
    }

    function updateSelectionUI() {
      if (pickedEl) pickedEl.innerHTML = pickedHTML(ctx);
      if (hintEl) hintEl.textContent = selectedHint(ctx);
      updateCalc();
      renderCandidates();
    }

    /* ---------- 候选列表（点击＝切换选中，不关闭，方便连续多选） ---------- */
    function renderCandidates() {
      // 只按「正在输入的最后一段」过滤：输入 zzh,zqy 时列表显示 zqy 的候选
      var kw = lastToken(s.search);
      var students = store.listStudents(kw);
      var exact = kw ? store.findStudentByName(kw) : null;
      var items = '';

      if (kw && !exact) {
        items += '<button type="button" class="combo-item combo-new" data-action="create-student" data-name="' + DOM.esc(kw) + '">' +
          '＋ 新建学生「' + DOM.esc(kw) + '」并选中</button>';
      }
      if (!students.length) {
        items += '<div class="combo-empty">没有匹配的学生</div>';
      } else {
        students.slice(0, 100).forEach(function (st) {
          var on = isSelected(st.id);
          var stats = store.studentStats(st.id);
          items += '<button type="button" class="combo-item' + (on ? ' selected' : '') + '" ' +
            'data-action="toggle-student" data-id="' + st.id + '">' +
              '<span class="ck-mark">' + (on ? '✓' : '') + '</span>' +
              '<span class="ci-name">' + DOM.esc(st.name) + '</span>' +
              '<span class="ci-meta">' + DOM.esc(st.className || st.studentNo || '') + '</span>' +
              '<span class="ci-money' + (stats.unpaidFen > 0 ? ' warn' : '') + '">' +
                (stats.unpaidFen > 0 ? '欠 ' + U.money(stats.unpaidFen) : U.money(stats.amountFen)) +
              '</span>' +
            '</button>';
        });
      }

      // ★ 工具条放在列表「顶部」并固定住（不随学生列表滚动），
      //   否则学生一多，就得先把列表滚到底才能点到「全选 / 清空」。
      //   没结果时、或只有 1 个结果且还没选人时，工具条没有意义，就不显示。
      var showTools = students.length > 1 || s.selectedIds.length > 0;
      var tools = '';
      if (showTools) {
        tools = '<div class="combo-tools">';
        if (students.length > 1) {
          tools += '<button type="button" class="mini-btn primary" data-action="select-all-results">' +
            '全选这 ' + students.length + ' 人</button>';
        }
        if (s.selectedIds.length) {
          tools += '<button type="button" class="mini-btn" data-action="clear-picked">' +
            '清空已选（' + s.selectedIds.length + '）</button>';
        }
        tools += '</div>';
      }

      if (listEl) {
        listEl.innerHTML = tools + '<div class="combo-items">' + items + '</div>';
      }
    }

    function openList() {
      renderCandidates();
      if (listEl) listEl.hidden = false;
    }
    function closeList() {
      if (listEl) listEl.hidden = true;
    }

    /* ---------- 选中 / 取消 ---------- */
    /**
     * 手动勾选 / 取消
     * ★ 取消时记进 excluded：本次输入期间「自动勾选」不会再把它勾回来
     *   （比如输入 zzh,zqy 后取消郑卓涵，再追加 zjb，郑卓涵仍然是未勾选）
     */
    function toggle(id) {
      var i = s.selectedIds.indexOf(id);
      if (i >= 0) {
        s.selectedIds.splice(i, 1);
        if (s.excluded.indexOf(id) < 0) s.excluded.push(id);
      } else {
        s.selectedIds.push(id);
        var e = s.excluded.indexOf(id);
        if (e >= 0) s.excluded.splice(e, 1);   // 手动勾回来 → 解除排除
      }
      updateSelectionUI();
    }

    /**
     * ★ 按分隔词自动勾选
     * 规则：
     *  - 每个词（长度 ≥ 2）去匹配学生，匹配到的人自动勾选；
     *  - 用户手动取消过的人（excluded）不勾；
     *  - 词被删掉 / 改短后，它之前自动勾选、且已不被任何词命中的人会自动取消。
     *    （所以输入 zz → zzh 时，zz 命中但 zzh 不再命中的那些人会自动退掉）
     */
    function autoSelectByTokens() {
      var tokens = splitTokens(s.search);
      var newMap = {};
      tokens.forEach(function (t) {
        if (t.length < AUTO_MIN_LEN) return;         // 太短容易一次选中一大片
        var ids = store.listStudents(t, AUTO_MIN_SCORE).map(function (st) { return st.id; });
        if (ids.length) newMap[t] = ids;
      });

      // ① 释放：上一轮有、这一轮没有的词
      var stillMatched = {};
      Object.keys(newMap).forEach(function (t) {
        newMap[t].forEach(function (id) { stillMatched[id] = true; });
      });
      Object.keys(s.autoMap || {}).forEach(function (t) {
        if (newMap[t]) return;
        (s.autoMap[t] || []).forEach(function (id) {
          if (stillMatched[id]) return;              // 还被别的词命中，保留
          var i = s.selectedIds.indexOf(id);
          if (i >= 0) s.selectedIds.splice(i, 1);
        });
      });

      // ② 勾选：这一轮的词匹配到的人（跳过手动排除过的）
      Object.keys(newMap).forEach(function (t) {
        newMap[t].forEach(function (id) {
          if (s.excluded.indexOf(id) >= 0) return;
          if (s.selectedIds.indexOf(id) < 0) s.selectedIds.push(id);
        });
      });

      s.autoMap = newMap;
    }

    /** 清空搜索框算「这一轮结束」：排除记录也一起清掉，下次重新来 */
    function resetTokenState() {
      s.autoMap = {};
      s.excluded = [];
    }

    searchInput.addEventListener('focus', openList);
    searchInput.addEventListener('input', function () {
      s.search = searchInput.value;
      if (!U.trim(s.search)) resetTokenState();
      else autoSelectByTokens();
      updateSelectionUI();
      openList();
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeList(); return; }
      if (e.key !== 'Enter') return;

      // 回车＝「这一段输入完成」：把最后一段匹配到的人都勾上，然后清空输入框继续下一批
      var tok = lastToken(s.search);
      if (!tok) return;
      var matched = store.listStudents(tok);          // 回车是明确操作，不设门槛
      if (matched.length) {
        matched.forEach(function (st) {
          if (s.selectedIds.indexOf(st.id) < 0) s.selectedIds.push(st.id);
          var idx = s.excluded.indexOf(st.id);
          if (idx >= 0) s.excluded.splice(idx, 1);
        });
        s.search = '';
        s.autoMap = {};                               // 已勾选的保留，不再回退
        searchInput.value = '';
        updateSelectionUI();
        openList();
        return;
      }
      // 没匹配到：中文名直接新建；纯字母先提示（避免建出 "zzh" 这种学生）
      if (/[\u4e00-\u9fa5]/.test(tok)) {
        createStudent(tok);
      } else {
        DOM.toast('没找到「' + tok + '」，可以先到「学生」页新建', 'error');
      }
    });

    DOM.qs('#q-search-clear', rootEl).addEventListener('click', function () {
      s.search = '';
      searchInput.value = '';
      resetTokenState();
      updateSelectionUI();
      openList();
    });

    // 点击页面其它地方收起候选列表；页面重绘时由 app.js 调用 P.UI.cleanup 解绑
    function onDocClick(e) {
      var combo = DOM.qs('#q-combo', rootEl);
      if (combo && !combo.contains(e.target)) closeList();
    }
    document.addEventListener('click', onDocClick);
    P.UI.cleanup = function () { document.removeEventListener('click', onDocClick); };

    DOM.on(listEl, 'click', '[data-action="toggle-student"]', function (e, btn) {
      e.stopPropagation();
      toggle(btn.dataset.id);
    });

    DOM.on(listEl, 'click', '[data-action="create-student"]', function (e, btn) {
      e.stopPropagation();
      createStudent(btn.dataset.name);
    });

    DOM.on(listEl, 'click', '[data-action="select-all-results"]', function (e, btn) {
      e.stopPropagation();
      // 「全选」是明确操作：连手动排除过的也一起勾上
      store.listStudents(lastToken(s.search)).forEach(function (st) {
        if (!isSelected(st.id)) s.selectedIds.push(st.id);
        var i = s.excluded.indexOf(st.id);
        if (i >= 0) s.excluded.splice(i, 1);
      });
      updateSelectionUI();
    });

    DOM.on(listEl, 'click', '[data-action="clear-picked"]', function (e, btn) {
      e.stopPropagation();
      // 清空＝完全重来：选择、搜索框、排除记录都清掉
      s.selectedIds = [];
      s.search = '';
      searchInput.value = '';
      resetTokenState();
      updateSelectionUI();
      openList();
    });

    DOM.on(rootEl, 'click', '[data-action="unpick"]', function (e, btn) {
      toggle(btn.dataset.id);
    });

    function createStudent(name) {
      try {
        var st = store.addStudent({ name: name });
        if (!isSelected(st.id)) s.selectedIds.push(st.id);
        s.search = '';
        searchInput.value = '';
        resetTokenState();
        DOM.toast('已新建并选中：' + st.name, 'success');
        app.refresh();
      } catch (err) {
        DOM.toast(err.message || '新建失败', 'error');
      }
    }

    /* ---------- 张数（支持半张） ---------- */
    DOM.on(rootEl, 'click', '[data-action="step"]', function (e, btn) {
      var field = btn.dataset.field;
      var delta = parseFloat(btn.dataset.delta) || 0;
      s[field] = P.Pricing.toSheets((s[field] || 0) + delta);
      updateCalc();
    });

    DOM.on(rootEl, 'click', '[data-action="chip"]', function (e, btn) {
      s[btn.dataset.field] = P.Pricing.toSheets(btn.dataset.value);
      updateCalc();
    });

    DOM.on(rootEl, 'input', '.counter-input', function (e, el) {
      s[el.dataset.field] = P.Pricing.toSheets(el.value);
      updateCalc();
    });

    /* ---------- 日期 / 时间 / 备注 ---------- */
    DOM.on(rootEl, 'change', '#q-date', function (e, el) { s.date = el.value || U.todayString(); });
    DOM.on(rootEl, 'change', '#q-time', function (e, el) { s.time = el.value || U.toTimeString(Date.now()); });
    DOM.on(rootEl, 'input', '#q-note', function (e, el) { s.note = el.value; });

    /* ---------- 保存 ---------- */
    function save(clearSelection) {
      if (!s.selectedIds.length) {
        DOM.toast('请先选择至少一名学生', 'error');
        return;
      }
      try {
        var res = store.addRecordsBatch(s.selectedIds, {
          sheets: s.sheets,
          date: s.date,
          time: s.time,
          note: s.note
        });

        s.lastBatchId = res.batchId;
        s.lastBatchCount = res.count;
        s.lastBatchTotalFen = res.totalAmountFen;

        DOM.toast('已记录 ' + res.count + ' 人 · 每人 ' + U.qty(res.sheets) + ' 张 ' + U.money(res.perAmountFen) +
          ' · 合计 ' + U.money(res.totalAmountFen), 'success', 3000);

        // 清空张数与备注，方便继续记下一单
        s.sheets = 0;
        s.note = '';
        s.date = U.todayString();
        s.time = U.toTimeString(Date.now());
        s.search = '';
        if (clearSelection) s.selectedIds = [];

        app.refresh();
      } catch (err) {
        DOM.toast(err.message || '保存失败', 'error');
      }
    }

    DOM.on(rootEl, 'click', '[data-action="save"]', function () { save(false); });
    DOM.on(rootEl, 'click', '[data-action="save-clear"]', function () { save(true); });

    /* ---------- 撤销上一批 ---------- */
    DOM.on(rootEl, 'click', '[data-action="undo-batch"]', function () {
      var info = store.getBatchInfo(s.lastBatchId);
      if (!info) { DOM.toast('这一批记录已经不在了', 'error'); return; }
      DOM.confirm({
        title: '撤销这一批',
        content: '将删除刚刚这一批（' + info.count + ' 人，合计 ' + U.money(info.totalAmountFen) +
          '）的全部记录：' + info.studentNames.join('、'),
        okText: '撤销'
      }).then(function (ok) {
        if (!ok) return;
        store.deleteBatch(s.lastBatchId);
        s.lastBatchId = '';
        DOM.toast('已撤销这一批记录', 'success');
        app.refresh();
      });
    });

    /* ---------- 初始化 ---------- */
    // 过滤掉已被删除的学生 id
    s.selectedIds = s.selectedIds.filter(function (id) { return !!store.getStudent(id); });
    updateCalc();
  }

  P.UI.Quick = { render: render, mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);