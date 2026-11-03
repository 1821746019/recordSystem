/*!
 * ui/dom.js —— 界面层公共组件（弹窗 / 提示 / 下载 / 选文件）
 * 这一层是「浏览器专用」的，迁移到小程序时用 wx.showModal / wx.showToast 替换。
 */
(function (root) {
  'use strict';
  var P = root.PrintSystem = root.PrintSystem || {};
  var U = P.Utils;
  P.UI = P.UI || {};

  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qsa(sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  }
  function esc(s) { return U.escapeHtml(s); }

  /** 事件委托：DOM.on(root, 'click', '[data-action]', handler) */
  function on(rootEl, type, selector, handler) {
    if (!rootEl) return;
    rootEl.addEventListener(type, function (e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      var hit = selector ? target.closest(selector) : target;
      if (hit && rootEl.contains(hit)) handler(e, hit);
    });
  }

  /* ------------------------- Toast ------------------------- */

  function toast(message, type, duration) {
    var wrap = document.getElementById('toast-root');
    if (!wrap) return;
    var node = document.createElement('div');
    node.className = 'toast toast-' + (type || 'info');
    node.textContent = message;
    wrap.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('show'); });
    setTimeout(function () {
      node.classList.remove('show');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
    }, duration || 2000);
  }

  /* ------------------------- Modal ------------------------- */

  /**
   * openModal({
   *   title, content(HTML字符串), okText, cancelText, sticky,
   *   onOpen(root), onOk(root) -> false 则不关闭 / Promise, onCancel()
   * })
   */
  function openModal(opts) {
    opts = opts || {};
    var mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
          '<h3>' + esc(opts.title || '') + '</h3>' +
          '<button type="button" class="modal-x" data-close aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="modal-body">' + (opts.content || '') + '</div>' +
        '<div class="modal-foot">' +
          '<button type="button" class="btn btn-ghost" data-close>' + esc(opts.cancelText || '取消') + '</button>' +
          '<button type="button" class="btn btn-primary" data-ok>' + esc(opts.okText || '确定') + '</button>' +
        '</div>' +
      '</div>';

    var root = document.getElementById('modal-root') || document.body;
    root.appendChild(mask);
    requestAnimationFrame(function () { mask.classList.add('show'); });

    var closed = false;
    function close(reason) {
      if (closed) return;
      closed = true;
      mask.classList.remove('show');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 180);
      if (reason === 'cancel' && typeof opts.onCancel === 'function') opts.onCancel();
    }

    mask.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t === mask) { if (!opts.sticky) close('cancel'); return; }
      if (t.closest('[data-close]')) { close('cancel'); return; }
      if (t.closest('[data-ok]')) {
        var r = opts.onOk ? opts.onOk(mask) : true;
        if (r === false) return;
        if (r && typeof r.then === 'function') {
          r.then(function (res) { if (res !== false) close('ok'); });
          return;
        }
        close('ok');
      }
    });

    // 表单里按回车＝确定
    mask.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA') {
        var okBtn = qs('[data-ok]', mask);
        if (okBtn) okBtn.click();
      }
    });

    if (typeof opts.onOpen === 'function') opts.onOpen(mask);

    return { root: mask, close: close };
  }

  /** 确认框，返回 Promise<Boolean> */
  function confirmModal(opts) {
    if (typeof opts === 'string') opts = { content: opts };
    opts = opts || {};
    return new Promise(function (resolve) {
      openModal({
        title: opts.title || '请确认',
        content: '<p class="confirm-text">' + esc(opts.content || '') + '</p>',
        okText: opts.okText || '确定',
        cancelText: opts.cancelText || '取消',
        onOk: function () { resolve(true); },
        onCancel: function () { resolve(false); }
      });
    });
  }

  /* ------------------------- 文件 ------------------------- */

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /** 弹出文件选择，返回 Promise<{name,text}> */
  function pickTextFile(accept) {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept || '.json,application/json';
      input.style.display = 'none';
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) { reject(new Error('未选择文件')); return; }
        var reader = new FileReader();
        reader.onload = function () { resolve({ name: file.name, text: String(reader.result || '') }); };
        reader.onerror = function () { reject(new Error('文件读取失败')); };
        reader.readAsText(file, 'utf-8');
      };
      document.body.appendChild(input);
      input.click();
      setTimeout(function () { if (input.parentNode) input.parentNode.removeChild(input); }, 60000);
    });
  }

  /** 今天/本月 的日期范围快捷值 */
  function rangeOf(key) {
    var today = U.todayString();
    if (key === 'today') return { from: today, to: today };
    if (key === 'week') return { from: U.startOfWeek(today), to: today };
    if (key === 'month') return { from: U.startOfMonth(today), to: today };
    return { from: '', to: '' };
  }

  P.UI.DOM = {
    qs: qs,
    qsa: qsa,
    esc: esc,
    on: on,
    toast: toast,
    openModal: openModal,
    confirm: confirmModal,
    download: download,
    pickTextFile: pickTextFile,
    rangeOf: rangeOf
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);