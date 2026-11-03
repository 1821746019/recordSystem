/*!
 * store.js —— 数据仓库（业务逻辑层）v3
 * ---------------------------------------------------------------
 * 整个系统的心脏：学生、打印记录、批量记账、收款结算、统计、导入导出。
 * 完全不碰 DOM，也不碰具体存储实现（通过 storage 适配器注入），因此可以：
 *   - 浏览器里跑（localStorage）
 *   - 微信小程序里跑（wx.setStorageSync，只需换 adapter）
 *   - node 里跑单元测试（内存 adapter）
 *
 * 数据结构（整棵状态树作为一个 JSON 存一个 key，简单可靠）：
 * {
 *   version: 3,
 *   settings: { shopName, operator, priceFen },
 *   students: [{ id, name, className, studentNo, phone, note, createdAt, updatedAt }],
 *   records:  [{ id, batchId, studentId, studentName, className, date, time,
 *                sheets, priceFen, amountFen, note,
 *                paymentId, paidAt, createdAt, updatedAt }],
 *   payments: [{ id, studentId, studentName, date, method,
 *                shouldAmountFen, amountFen, discountFen, note, recordIds,
 *                createdAt }]
 * }
 *
 * 设计要点：
 *  1) 【只记张数】v3 起不再区分单面/双面，记录里只有 `sheets`（张数）。
 *     金额 = 张数 × 单价（priceFen，默认 0.30 元/张）。
 *     保存记录时冻结当时单价，以后改价不会影响历史账单。
 *  2) 【金额用分】一律用「分」为单位的整数，避免浮点误差。
 *  3) 【批量记账】一次给多个学生记同样的账时，这些记录共享一个 batchId，
 *     可整批撤销；但每个学生仍是独立的一条记录，方便分开结账。
 *  4) 【结清】= 记录挂上收款单（paymentId）。未结清金额 = 未挂单记录金额之和，
 *     逻辑单一，不会出现「收款总额对不上」的糊涂账；撤销就是把 paymentId 摘掉。
 */
(function (root, factory) {
  'use strict';
  var mod;
  if (typeof module !== 'undefined' && module.exports) {
    mod = factory(require('./utils.js'), require('./pricing.js'), require('./pinyin.js'), require('./storage.js'));
  } else {
    root.PrintSystem = root.PrintSystem || {};
    mod = factory(root.PrintSystem.Utils, root.PrintSystem.Pricing, root.PrintSystem.Pinyin, root.PrintSystem.Storage);
  }
  root.PrintSystem = root.PrintSystem || {};
  root.PrintSystem.Store = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this,
  function (Utils, Pricing, Pinyin, Storage) {
    'use strict';

    /**
     * 数据版本：
     *   v1 → v2：单/双面两个单价合并为一个统一单价
     *   v2 → v3：不再区分单面/双面，记录只保留张数 sheets
     */
    var SCHEMA_VERSION = 3;
    var DEFAULT_KEY = 'pps_data_v1';
    var PAY_METHODS = ['现金', '微信', '支付宝', '转账', '其他'];

    var DEFAULT_SETTINGS = {
      shopName: '打印记录系统',
      operator: '',
      priceFen: Pricing.DEFAULT_PRICING.priceFen   // 30 = 0.30 元/张
    };

    /* ===================== 结构与校验 ===================== */

    function emptyState() {
      return {
        version: SCHEMA_VERSION,
        settings: Utils.deepClone(DEFAULT_SETTINGS),
        students: [],
        records: [],
        payments: []
      };
    }

    function mergeSettings(raw) {
      var s = Utils.deepClone(DEFAULT_SETTINGS);
      raw = raw || {};
      if (raw.shopName != null) s.shopName = Utils.trim(raw.shopName) || DEFAULT_SETTINGS.shopName;
      if (raw.operator != null) s.operator = Utils.trim(raw.operator);
      // 兼容 v1：只有单/双面两个价时，取双面价作为统一价
      if (raw.priceFen != null) {
        s.priceFen = Math.max(0, Utils.toInt(raw.priceFen, s.priceFen));
      } else if (raw.doublePriceFen != null) {
        s.priceFen = Math.max(0, Utils.toInt(raw.doublePriceFen, s.priceFen));
      } else if (raw.singlePriceFen != null) {
        s.priceFen = Math.max(0, Utils.toInt(raw.singlePriceFen, s.priceFen));
      }
      return s;
    }

    function normalizeStudent(raw) {
      if (!raw || typeof raw !== 'object') return null;
      var name = Utils.trim(raw.name);
      if (!name) return null;
      var now = Date.now();
      return {
        id: raw.id || Utils.uid('stu'),
        name: name,
        className: Utils.trim(raw.className),
        studentNo: Utils.trim(raw.studentNo),
        phone: Utils.trim(raw.phone),
        note: Utils.trim(raw.note),
        createdAt: raw.createdAt || now,
        updatedAt: raw.updatedAt || raw.createdAt || now
      };
    }

    function normalizeRecord(raw) {
      if (!raw || typeof raw !== 'object') return null;

      // 兼容 v2 及更早：张数拆在 singleSheets / doubleSheets 里，这里合并成 sheets
      var legacySheets = Utils.toInt(raw.singleSheets, 0) + Utils.toInt(raw.doubleSheets, 0);
      var calc = Pricing.calculate(
        { sheets: raw.sheets != null ? raw.sheets : legacySheets },
        {
          priceFen: raw.priceFen != null ? raw.priceFen
            : (raw.doublePriceFen != null ? raw.doublePriceFen : raw.singlePriceFen)
        }
      );
      var created = raw.createdAt || Date.now();
      return {
        id: raw.id || Utils.uid('rec'),
        batchId: Utils.trim(raw.batchId),          // 批量记账的批次号；单条记录为空
        studentId: raw.studentId || '',
        studentName: Utils.trim(raw.studentName),
        className: Utils.trim(raw.className),
        date: raw.date || Utils.toDateString(created),
        time: raw.time || Utils.toTimeString(created),
        sheets: calc.sheets,
        priceFen: calc.pricing.priceFen,
        // 历史金额优先保留：旧版本单价不同，重算会改动旧账
        amountFen: (typeof raw.amountFen === 'number' && isFinite(raw.amountFen))
          ? Math.round(raw.amountFen) : calc.amountFen,
        note: Utils.trim(raw.note),
        paymentId: raw.paymentId || null,
        paidAt: raw.paidAt || null,
        createdAt: created,
        updatedAt: raw.updatedAt || created
      };
    }

    function normalizePayment(raw) {
      if (!raw || typeof raw !== 'object') return null;
      var created = raw.createdAt || Date.now();
      return {
        id: raw.id || Utils.uid('pay'),
        studentId: raw.studentId || '',
        studentName: Utils.trim(raw.studentName),
        date: raw.date || Utils.toDateString(created),
        method: Utils.trim(raw.method) || '现金',
        shouldAmountFen: Utils.toInt(raw.shouldAmountFen, 0),
        amountFen: Utils.toInt(raw.amountFen, 0),
        discountFen: Utils.toInt(raw.discountFen, 0),
        note: Utils.trim(raw.note),
        recordIds: Array.isArray(raw.recordIds) ? raw.recordIds.slice() : [],
        createdAt: created
      };
    }

    /** 把任意来源的数据洗成合法状态树（导入、旧版本升级都走这里） */
    function normalizeState(raw) {
      var s = emptyState();
      if (!raw || typeof raw !== 'object') return s;
      s.settings = mergeSettings(raw.settings);
      s.students = (Array.isArray(raw.students) ? raw.students : []).map(normalizeStudent).filter(Boolean);
      s.records = (Array.isArray(raw.records) ? raw.records : []).map(normalizeRecord).filter(Boolean);
      s.payments = (Array.isArray(raw.payments) ? raw.payments : []).map(normalizePayment).filter(Boolean);

      // 修复悬空关联：记录挂了一个不存在的收款单
      var payIds = {};
      s.payments.forEach(function (p) { payIds[p.id] = true; });
      s.records.forEach(function (r) {
        if (r.paymentId && !payIds[r.paymentId]) {
          r.paymentId = null;
          r.paidAt = null;
        }
      });
      // 清理收款单里已失效的记录 id
      var recIds = {};
      s.records.forEach(function (r) { recIds[r.id] = true; });
      s.payments.forEach(function (p) {
        p.recordIds = p.recordIds.filter(function (id) { return recIds[id]; });
      });
      return s;
    }

    /* ===================== 仓储 ===================== */

    function createStore(options) {
      options = options || {};
      var adapter = options.adapter || Storage.createLocalStorageAdapter();
      var storageKey = options.key || DEFAULT_KEY;
      var autoSave = options.autoSave !== false;
      var listeners = [];
      var state = emptyState();

      /* ---------- 持久化 ---------- */

      function load() {
        var raw = adapter.getItem(storageKey);
        if (!raw) return emptyState();
        var parsed;
        try {
          parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        } catch (e) {
          console.warn('[store] 数据解析失败，已使用空数据。', e);
          return emptyState();
        }
        return migrate(parsed);
      }

      /**
       * 版本升级入口。
       *   v1 → v2：settings.singlePriceFen/doublePriceFen 合并为 priceFen（取双面价）
       *   v2 → v3：records 的 singleSheets/doubleSheets 合并为 sheets（去掉页数概念）
       * 两者都由 mergeSettings / normalizeRecord 完成，这里只负责推进版本号。
       * 历史 amountFen 一律原样保留。
       */
      function migrate(raw) {
        var data = raw || {};
        var v = Utils.toInt(data.version, 0);
        var s = normalizeState(data);
        if (v !== SCHEMA_VERSION) {
          console.info('[store] 数据已从 v' + v + ' 升级到 v' + SCHEMA_VERSION +
            '（计费简化为：张数 × 单价）');
        }
        s.version = SCHEMA_VERSION;
        return s;
      }

      function persist() {
        if (!autoSave) return;
        try {
          adapter.setItem(storageKey, JSON.stringify(state));
        } catch (e) {
          console.error('[store] 保存失败', e);
        }
      }

      function emit() {
        listeners.slice().forEach(function (fn) {
          try { fn(state); } catch (e) { console.error('[store] 监听器执行出错', e); }
        });
      }

      function commit() {
        persist();
        emit();
      }

      state = load();

      /* ---------- 内部查找 ---------- */

      function findStudent(id) {
        if (!id) return null;
        for (var i = 0; i < state.students.length; i++) {
          if (state.students[i].id === id) return state.students[i];
        }
        return null;
      }

      function findRecord(id) {
        for (var i = 0; i < state.records.length; i++) {
          if (state.records[i].id === id) return state.records[i];
        }
        return null;
      }

      function findPayment(id) {
        for (var i = 0; i < state.payments.length; i++) {
          if (state.payments[i].id === id) return state.payments[i];
        }
        return null;
      }

      function summarize(list) {
        var out = {
          count: (list || []).length,
          sheets: 0,
          amountFen: 0, paidFen: 0, unpaidFen: 0,
          paidCount: 0, unpaidCount: 0
        };
        (list || []).forEach(function (r) {
          // 张数可能是 0.5 的倍数，这里不能取整，否则 0.5 张会被算成 0
          out.sheets += (Number(r.sheets) || 0);
          out.amountFen += r.amountFen;
          if (r.paymentId) {
            out.paidFen += r.amountFen;
            out.paidCount++;
          } else {
            out.unpaidFen += r.amountFen;
            out.unpaidCount++;
          }
        });
        return out;
      }

      /** 按「当前设置」为一名学生拼一条记录（不落库，由调用方 push） */
      function buildRecord(student, calc, data, batchId, now) {
        return {
          id: Utils.uid('rec'),
          batchId: batchId || '',
          studentId: student.id,
          studentName: student.name,
          className: student.className,
          date: data.date || Utils.todayString(),
          time: data.time || Utils.toTimeString(now),
          sheets: calc.sheets,
          priceFen: calc.pricing.priceFen,
          amountFen: calc.amountFen,
          note: Utils.trim(data.note),
          paymentId: null,
          paidAt: null,
          createdAt: now,
          updatedAt: now
        };
      }

      /* ---------- 对外 API ---------- */

      var api = {
        SCHEMA_VERSION: SCHEMA_VERSION,
        PAY_METHODS: PAY_METHODS,
        storageKey: storageKey,
        storageName: adapter.name || 'custom',
        /** 'full' = 拼音搜索可用；'plain' = 环境不支持，已降级为原文匹配 */
        pinyinMode: Pinyin.mode,

        /* ===== 基础 ===== */

        getState: function () { return state; },

        subscribe: function (fn) {
          listeners.push(fn);
          return function () {
            var i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          };
        },

        /** 数据被外部改动（例如小程序 onShow 时重新读缓存）后调用 */
        reload: function () {
          state = load();
          emit();
          return state;
        },

        /* ===== 设置 ===== */

        getSettings: function () { return Utils.deepClone(state.settings); },

        getPricing: function () { return Pricing.normalize(state.settings); },

        updateSettings: function (patch) {
          state.settings = mergeSettings(Object.assign({}, state.settings, patch || {}));
          commit();
          return Utils.deepClone(state.settings);
        },

        /* ===== 学生 ===== */

        /**
         * 查学生（支持姓名 / 班级 / 学号 / 电话）
         * ★ 支持拼音与首字母模糊搜索：
         *   '张' / 'zxm' / 'zhangxiao' / 'zhangxm' / 'xiao' / 'xm' / '高一' / 'gy' / '20240301'
         * 带关键字时按相关度排序（越匹配越靠前），不带关键字时按建档时间排序。
         *
         * @param {String} keyword
         * @param {Number} minScore 可选：只要相关度 ≥ 这个分数的人（默认 1，即只要命中就要）。
         *        批量选中（逗号分隔）时传 66，可过滤掉「全拼中间片段」这类很松的匹配。
         */
        listStudents: function (keyword, minScore) {
          var list = state.students.slice();
          var k = Utils.trim(keyword);
          if (!k) return Utils.sortByAsc(list, function (s) { return s.createdAt; });

          var min = (typeof minScore === 'number') ? minScore : 1;
          var scored = [];
          for (var i = 0; i < list.length; i++) {
            var s = list[i];
            var score = Pinyin.searchScore([s.name, s.className, s.studentNo, s.phone], k);
            if (score >= min) scored.push({ s: s, score: score });
          }
          scored.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return Utils.compareName(a.s.name, b.s.name);
          });
          return scored.map(function (x) { return x.s; });
        },

        getStudent: function (id) {
          var s = findStudent(id);
          return s ? Utils.deepClone(s) : null;
        },

        findStudentByName: function (name) {
          var n = Utils.trim(name);
          if (!n) return null;
          var hit = state.students.filter(function (s) { return s.name === n; })[0];
          return hit ? Utils.deepClone(hit) : null;
        },

        /**
         * 新增学生。同名（且同班级）默认复用已有档案，避免重复建人。
         * @return {Object} student
         */
        addStudent: function (data) {
          data = data || {};
          var name = Utils.trim(data.name);
          if (!name) throw new Error('请填写学生姓名');
          var className = Utils.trim(data.className);

          if (!data.allowDuplicate) {
            var exist = state.students.filter(function (s) {
              return s.name === name && s.className === className;
            })[0];
            if (exist) return Utils.deepClone(exist);
          }

          var now = Date.now();
          var student = {
            id: Utils.uid('stu'),
            name: name,
            className: className,
            studentNo: Utils.trim(data.studentNo),
            phone: Utils.trim(data.phone),
            note: Utils.trim(data.note),
            createdAt: now,
            updatedAt: now
          };
          state.students.push(student);
          commit();
          return Utils.deepClone(student);
        },

        updateStudent: function (id, patch) {
          var s = findStudent(id);
          if (!s) throw new Error('学生不存在');
          patch = patch || {};
          if (patch.name != null) {
            var name = Utils.trim(patch.name);
            if (!name) throw new Error('请填写学生姓名');
            s.name = name;
          }
          if (patch.className != null) s.className = Utils.trim(patch.className);
          if (patch.studentNo != null) s.studentNo = Utils.trim(patch.studentNo);
          if (patch.phone != null) s.phone = Utils.trim(patch.phone);
          if (patch.note != null) s.note = Utils.trim(patch.note);
          s.updatedAt = Date.now();

          // 同步记录上的冗余姓名字段（方便导出/展示）
          state.records.forEach(function (r) {
            if (r.studentId === s.id) {
              r.studentName = s.name;
              r.className = s.className;
            }
          });
          commit();
          return Utils.deepClone(s);
        },

        /**
         * 删除学生
         * @param {Object} opts { deleteRecords:Boolean } 是否连同记录一起删
         */
        deleteStudent: function (id, opts) {
          opts = opts || {};
          var idx = -1;
          for (var i = 0; i < state.students.length; i++) {
            if (state.students[i].id === id) { idx = i; break; }
          }
          if (idx < 0) throw new Error('学生不存在');
          var student = state.students[idx];

          if (opts.deleteRecords) {
            var recIds = {};
            state.records.forEach(function (r) { if (r.studentId === id) recIds[r.id] = true; });
            state.records = state.records.filter(function (r) { return !recIds[r.id]; });
            state.payments = state.payments.filter(function (p) { return p.studentId !== id; });
            state.payments.forEach(function (p) {
              p.recordIds = p.recordIds.filter(function (rid) { return !recIds[rid]; });
            });
          } else {
            // 保留历史记录：解除关联，仅保留姓名快照
            state.records.forEach(function (r) {
              if (r.studentId === id) {
                r.studentId = '';
                if (!r.studentName) r.studentName = student.name;
              }
            });
          }

          state.students.splice(idx, 1);
          commit();
          return { removed: true, records: opts.deleteRecords ? 'deleted' : 'kept' };
        },

        /* ===== 打印记录 ===== */

        /**
         * 新增一条打印记录（按当前单价计算金额并冻结单价）
         * @param {Object} data { studentId, date, time, sheets, note, batchId }
         */
        addRecord: function (data) {
          data = data || {};
          var student = findStudent(data.studentId);
          if (!student) throw new Error('请先选择学生');

          var calc = Pricing.calculate(data, api.getPricing());
          if (calc.sheets <= 0) throw new Error('请填写打印张数');

          var record = buildRecord(student, calc, data, Utils.trim(data.batchId), Date.now());
          state.records.push(record);
          commit();
          return Utils.deepClone(record);
        },

        /**
         * 【批量记账】一次给多个学生记同样的一份账
         * （例如「高一(3)班 5 个人，每人 5 张」）
         *
         * @param {Array}  studentIds 学生 id 数组（自动去重、忽略不存在的）
         * @param {Object} data { sheets, date, time, note }
         * @return {Object} { batchId, count, records, perAmountFen, totalAmountFen, skipped }
         */
        addRecordsBatch: function (studentIds, data) {
          data = data || {};
          var ids = Array.isArray(studentIds) ? studentIds : [studentIds];

          var calc = Pricing.calculate(data, api.getPricing());
          if (calc.sheets <= 0) throw new Error('请填写打印张数');

          var seen = {};
          var students = [];
          ids.forEach(function (id) {
            if (!id || seen[id]) return;
            seen[id] = true;
            var st = findStudent(id);
            if (st) students.push(st);
          });
          if (!students.length) throw new Error('请至少选择一名学生');

          var batchId = Utils.uid('bat');
          var now = Date.now();
          var created = [];
          students.forEach(function (student) {
            var record = buildRecord(student, calc, data, batchId, now);
            state.records.push(record);
            created.push(record);
          });
          commit();

          return {
            batchId: batchId,
            count: created.length,
            skipped: ids.length - created.length,
            records: Utils.deepClone(created),
            sheets: calc.sheets,                       // 每人张数
            perAmountFen: calc.amountFen,              // 每人金额
            totalSheets: calc.sheets * created.length, // 本批总张数
            totalAmountFen: calc.amountFen * created.length
          };
        },

        getRecord: function (id) {
          var r = findRecord(id);
          return r ? Utils.deepClone(r) : null;
        },

        /** 编辑记录。金额按「记录自身冻结的单价」重算，不跟随当前设置。 */
        updateRecord: function (id, patch) {
          var r = findRecord(id);
          if (!r) throw new Error('记录不存在');
          patch = patch || {};

          if (patch.studentId && patch.studentId !== r.studentId) {
            var st = findStudent(patch.studentId);
            if (!st) throw new Error('学生不存在');
            r.studentId = st.id;
            r.studentName = st.name;
            r.className = st.className;
          }
          if (patch.date != null && patch.date !== '') r.date = patch.date;
          if (patch.time != null) r.time = patch.time;
          if (patch.note != null) r.note = Utils.trim(patch.note);
          if (patch.sheets != null) r.sheets = patch.sheets;
          if (patch.priceFen != null) r.priceFen = Utils.toInt(patch.priceFen, r.priceFen);

          var calc = Pricing.calculate(r, { priceFen: r.priceFen });
          if (calc.sheets <= 0) throw new Error('张数不能为 0');
          r.sheets = calc.sheets;
          r.priceFen = calc.pricing.priceFen;
          r.amountFen = calc.amountFen;
          r.updatedAt = Date.now();

          commit();
          return Utils.deepClone(r);
        },

        deleteRecord: function (id) {
          return api.deleteRecords([id]);
        },

        deleteRecords: function (ids) {
          var idMap = {};
          (ids || []).forEach(function (i) { idMap[i] = true; });
          var before = state.records.length;
          state.records = state.records.filter(function (r) { return !idMap[r.id]; });
          // 收款单里摘掉这些记录，空的收款单删掉
          state.payments.forEach(function (p) {
            p.recordIds = p.recordIds.filter(function (rid) { return !idMap[rid]; });
          });
          state.payments = state.payments.filter(function (p) { return p.recordIds.length > 0; });
          commit();
          return { removed: before - state.records.length };
        },

        /* ===== 批量记账的批次 ===== */

        /** 查一批的全部记录 */
        getBatch: function (batchId) {
          if (!batchId) return [];
          return state.records
            .filter(function (r) { return r.batchId === batchId; })
            .map(Utils.deepClone);
        },

        /** 一批的概览：人数、每人张数、本批合计 */
        getBatchInfo: function (batchId) {
          var records = api.getBatch(batchId);
          if (!records.length) return null;
          var sum = summarize(records);
          return {
            batchId: batchId,
            count: records.length,
            studentNames: records.map(function (r) { return r.studentName; }),
            date: records[0].date,
            time: records[0].time,
            note: records[0].note,
            sheets: records[0].sheets,          // 每人多少张
            priceFen: records[0].priceFen,
            totalSheets: sum.sheets,            // 本批总张数
            perAmountFen: records[0].amountFen, // 每人金额
            totalAmountFen: sum.amountFen,
            unpaidFen: sum.unpaidFen,
            records: records
          };
        },

        /** 整批撤销（删掉这一批产生的所有记录） */
        deleteBatch: function (batchId) {
          var records = api.getBatch(batchId);
          if (!records.length) return { removed: 0 };
          return api.deleteRecords(records.map(function (r) { return r.id; }));
        },

        /** { batchId: 条数 } —— 记录页用来标「同批」 */
        batchCounts: function () {
          var map = {};
          state.records.forEach(function (r) {
            if (!r.batchId) return;
            map[r.batchId] = (map[r.batchId] || 0) + 1;
          });
          return map;
        },

        /* ===== 收款 / 结算 ===== */

        /**
         * 结算一组记录：生成一张收款单，并把记录标记为已结清
         * @param {Array}  recordIds
         * @param {Object} options { studentId, amountFen, method, date, note }
         */
        settleRecords: function (recordIds, options) {
          options = options || {};
          var ids = Array.isArray(recordIds) ? recordIds : [recordIds];
          var idMap = {};
          ids.forEach(function (i) { idMap[i] = true; });

          var records = state.records.filter(function (r) { return idMap[r.id] && !r.paymentId; });
          if (!records.length) throw new Error('没有可结算的记录（可能已结清）');

          var shouldFen = Utils.sum(records, function (r) { return r.amountFen; });
          var amountFen = (options.amountFen == null) ? shouldFen : Math.round(options.amountFen);
          var studentId = options.studentId || records[0].studentId;
          var student = findStudent(studentId);
          var now = Date.now();

          var payment = {
            id: Utils.uid('pay'),
            studentId: studentId,
            studentName: student ? student.name : (records[0].studentName || ''),
            date: options.date || Utils.todayString(),
            method: Utils.trim(options.method) || '现金',
            shouldAmountFen: shouldFen,
            amountFen: amountFen,
            discountFen: Math.max(0, shouldFen - amountFen),
            note: Utils.trim(options.note),
            recordIds: records.map(function (r) { return r.id; }),
            createdAt: now
          };
          state.payments.push(payment);
          records.forEach(function (r) {
            r.paymentId = payment.id;
            r.paidAt = now;
            r.updatedAt = now;
          });
          commit();
          return Utils.deepClone(payment);
        },

        /** 撤销结清（记录回到未结清；关联的收款单若空则删除） */
        unsettleRecords: function (ids) {
          var idMap = {};
          (Array.isArray(ids) ? ids : [ids]).forEach(function (i) { idMap[i] = true; });
          var n = 0;
          state.records.forEach(function (r) {
            if (idMap[r.id] && r.paymentId) {
              var p = findPayment(r.paymentId);
              if (p) p.recordIds = p.recordIds.filter(function (x) { return x !== r.id; });
              r.paymentId = null;
              r.paidAt = null;
              r.updatedAt = Date.now();
              n++;
            }
          });
          state.payments = state.payments.filter(function (p) { return p.recordIds.length > 0; });
          commit();
          return { unsettled: n };
        },

        listPayments: function (filter) {
          filter = filter || {};
          var list = state.payments.slice();
          if (filter.studentId) {
            list = list.filter(function (p) { return p.studentId === filter.studentId; });
          }
          if (filter.from) list = list.filter(function (p) { return p.date >= filter.from; });
          if (filter.to) list = list.filter(function (p) { return p.date <= filter.to; });
          list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
          return list;
        },

        getPayment: function (id) {
          var p = findPayment(id);
          return p ? Utils.deepClone(p) : null;
        },

        deletePayment: function (id) {
          var p = findPayment(id);
          if (!p) throw new Error('收款记录不存在');
          var idSet = {};
          p.recordIds.forEach(function (r) { idSet[r] = true; });
          state.records.forEach(function (r) {
            if (idSet[r.id] || r.paymentId === id) {
              r.paymentId = null;
              r.paidAt = null;
            }
          });
          state.payments = state.payments.filter(function (x) { return x.id !== id; });
          commit();
          return { removed: true };
        },

        /* ===== 查询统计 ===== */

        /**
         * 查记录
         * @param {Object} filter { studentId, keyword, from, to, status, batchId, sort, limit }
         *   status: 'all' | 'unpaid' | 'paid'
         *   sort:   'desc'(默认,新→旧) | 'asc'
         */
        queryRecords: function (filter) {
          filter = filter || {};
          var list = state.records.slice();

          if (filter.studentId) {
            list = list.filter(function (r) { return r.studentId === filter.studentId; });
          }
          if (filter.batchId) {
            list = list.filter(function (r) { return r.batchId === filter.batchId; });
          }
          if (filter.from) list = list.filter(function (r) { return r.date >= filter.from; });
          if (filter.to) list = list.filter(function (r) { return r.date <= filter.to; });
          if (filter.status === 'unpaid') list = list.filter(function (r) { return !r.paymentId; });
          if (filter.status === 'paid') list = list.filter(function (r) { return !!r.paymentId; });

          var kw = Utils.trim(filter.keyword);
          if (kw) {
            var lowKw = kw.toLowerCase();
            list = list.filter(function (r) {
              // 学生姓名 / 班级支持拼音与首字母；备注和日期按原文匹配
              if (Pinyin.searchScore([r.studentName, r.className], kw) > 0) return true;
              return ((r.note || '') + ' ' + (r.date || '') + ' ' + (r.time || ''))
                .toLowerCase().indexOf(lowKw) >= 0;
            });
          }

          var desc = filter.sort !== 'asc';
          list.sort(function (a, b) {
            var ka = (a.date || '') + ' ' + (a.time || '00:00');
            var kb = (b.date || '') + ' ' + (b.time || '00:00');
            if (ka === kb) return (b.createdAt || 0) - (a.createdAt || 0);
            return desc ? (ka < kb ? 1 : -1) : (ka > kb ? 1 : -1);
          });

          if (filter.limit) list = list.slice(0, filter.limit);
          return list;
        },

        /** 汇总一组记录：张数 / 金额 / 已结清 / 未结清 */
        summarize: summarize,

        /** 按批次汇总（用于批量记账的统计展示） */
        batchList: function (filter) {
          filter = filter || {};
          var byBatch = {};
          state.records.forEach(function (r) {
            if (!r.batchId) return;
            if (filter.from && r.date < filter.from) return;
            if (filter.to && r.date > filter.to) return;
            (byBatch[r.batchId] = byBatch[r.batchId] || []).push(r);
          });
          return Object.keys(byBatch).map(function (bid) {
            var recs = byBatch[bid];
            recs.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
            var sum = summarize(recs);
            var first = recs[0];
            return {
              batchId: bid,
              count: recs.length,
              studentNames: recs.map(function (r) { return r.studentName; }),
              date: first.date,
              time: first.time,
              note: first.note,
              perSheets: first.sheets,        // 每人张数
              perAmountFen: first.amountFen,  // 每人金额
              sheets: sum.sheets,             // 本批总张数
              amountFen: sum.amountFen,
              unpaidFen: sum.unpaidFen,
              createdAt: first.createdAt
            };
          }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        },

        /** 某个学生的账目情况 */
        studentStats: function (studentId) {
          var records = state.records.filter(function (r) { return r.studentId === studentId; });
          var sum = summarize(records);
          var dates = records.map(function (r) { return r.date; }).sort();
          var unpaidIds = records.filter(function (r) { return !r.paymentId; }).map(function (r) { return r.id; });
          var payments = state.payments.filter(function (p) { return p.studentId === studentId; });

          var byMonth = Utils.groupBy(records, function (r) { return Utils.monthKey(r.date); });
          var monthly = Object.keys(byMonth).sort().reverse().map(function (m) {
            var s = summarize(byMonth[m]);
            s.month = m;
            return s;
          });

          sum.student = findStudent(studentId);
          sum.recordCount = sum.count;
          sum.unpaidRecordIds = unpaidIds;
          sum.receivedFen = Utils.sum(payments, function (p) { return p.amountFen; });
          sum.paymentCount = payments.length;
          sum.lastDate = dates.length ? dates[dates.length - 1] : '';
          sum.firstDate = dates.length ? dates[0] : '';
          sum.monthly = monthly;
          return sum;
        },

        /** 全局概览 */
        overview: function () {
          var today = Utils.todayString();
          var sum = summarize(state.records);
          var todayList = state.records.filter(function (r) { return r.date === today; });
          var month = Utils.monthKey(today);
          var monthList = state.records.filter(function (r) { return Utils.monthKey(r.date) === month; });
          var t = summarize(todayList);
          var m = summarize(monthList);

          return {
            studentCount: state.students.length,
            recordCount: sum.count,
            sheets: sum.sheets,
            amountFen: sum.amountFen,
            paidFen: sum.paidFen,
            unpaidFen: sum.unpaidFen,
            unpaidCount: sum.unpaidCount,
            receivedFen: Utils.sum(state.payments, function (p) { return p.amountFen; }),
            paymentCount: state.payments.length,
            today: { count: t.count, sheets: t.sheets, amountFen: t.amountFen },
            month: { count: m.count, sheets: m.sheets, amountFen: m.amountFen, month: month }
          };
        },

        /** 按月汇总（倒序） */
        monthlyStats: function () {
          var byMonth = Utils.groupBy(state.records, function (r) { return Utils.monthKey(r.date); });
          return Object.keys(byMonth).sort().reverse().map(function (m) {
            var s = summarize(byMonth[m]);
            s.month = m;
            s.receivedFen = Utils.sum(
              state.payments.filter(function (p) { return Utils.monthKey(p.date) === m; }),
              function (p) { return p.amountFen; }
            );
            return s;
          });
        },

        /** 按学生汇总排行（金额倒序，只保留有记录的） */
        studentRanking: function (filter) {
          filter = filter || {};
          var list = state.students.slice();
          if (filter.keyword) {
            var k = Utils.trim(filter.keyword).toLowerCase();
            list = list.filter(function (s) {
              return (s.name + ' ' + s.className + ' ' + s.studentNo).toLowerCase().indexOf(k) >= 0;
            });
          }
          var rows = list.map(function (s) {
            var st = api.studentStats(s.id);
            st.student = s;
            return st;
          }).filter(function (st) { return st.recordCount > 0; });
          rows.sort(function (a, b) {
            if (b.amountFen !== a.amountFen) return b.amountFen - a.amountFen;
            return Utils.compareName(a.student.name, b.student.name);
          });
          return rows;
        },

        /** 未结清的学生列表（欠款看板） */
        unpaidStudents: function () {
          return Utils.sortByDesc(
            state.students.map(function (s) {
              var st = api.studentStats(s.id);
              st.student = s;
              return st;
            }).filter(function (st) { return st.unpaidFen > 0; }),
            function (st) { return st.unpaidFen; }
          );
        },

        /* ===== 导入导出 ===== */

        exportObject: function () { return Utils.deepClone(state); },

        exportJSON: function (pretty) {
          return JSON.stringify(state, null, pretty === false ? 0 : 2);
        },

        /**
         * 导入数据
         * @param {String|Object} input JSON 字符串或对象
         * @param {Object} opts { mode: 'replace'(默认) | 'merge' }
         */
        importJSON: function (input, opts) {
          opts = opts || {};
          var raw;
          if (typeof input === 'string') {
            raw = JSON.parse(input);   // 解析失败会抛错，交给调用方提示
          } else {
            raw = input;
          }
          var incoming = normalizeState(raw);
          var stats = {
            students: incoming.students.length,
            records: incoming.records.length,
            payments: incoming.payments.length
          };

          if (opts.mode === 'merge') {
            var stuId = {}, recId = {}, payId = {};
            state.students.forEach(function (s) { stuId[s.id] = true; });
            state.records.forEach(function (r) { recId[r.id] = true; });
            state.payments.forEach(function (p) { payId[p.id] = true; });
            incoming.students.forEach(function (s) { if (!stuId[s.id]) state.students.push(s); });
            incoming.payments.forEach(function (p) { if (!payId[p.id]) state.payments.push(p); });
            incoming.records.forEach(function (r) { if (!recId[r.id]) state.records.push(r); });
            stats.mode = 'merge';
          } else {
            state = incoming;
            stats.mode = 'replace';
          }
          commit();
          return stats;
        },

        /** 清空业务数据（保留设置） */
        clearData: function () {
          state.students = [];
          state.records = [];
          state.payments = [];
          commit();
          return true;
        },

        /** 恢复出厂设置 */
        reset: function () {
          state = emptyState();
          commit();
          return true;
        },

        /* ---- CSV 导出 ---- */

        exportRecordsCSV: function (records) {
          records = records || api.queryRecords({});
          var rows = [[
            '日期', '时间', '学生', '班级', '张数', '单价(元/张)', '金额(元)',
            '状态', '结算日期', '内容/备注', '批次号'
          ]];
          records.forEach(function (r) {
            rows.push([
              r.date,
              r.time,
              r.studentName || '（已删除）',
              r.className || '',
              r.sheets,
              Utils.fenToYuan(r.priceFen),
              Utils.fenToYuan(r.amountFen),
              r.paymentId ? '已结清' : '未结清',
              r.paidAt ? Utils.toDateString(r.paidAt) : '',
              r.note || '',
              r.batchId || ''
            ]);
          });
          return Utils.excelCSV(rows);
        },

        exportStudentsCSV: function () {
          var rows = [[
            '学生', '班级', '学号', '电话', '记录数', '总张数',
            '累计金额(元)', '已结清(元)', '未结清(元)', '最近打印'
          ]];
          var list = api.listStudents('').map(function (s) {
            var st = api.studentStats(s.id);
            st.student = s;
            return st;
          });
          list.sort(function (a, b) { return b.amountFen - a.amountFen; });
          list.forEach(function (st) {
            var s = st.student;
            rows.push([
              s.name, s.className, s.studentNo, s.phone,
              st.recordCount, st.sheets,
              Utils.fenToYuan(st.amountFen),
              Utils.fenToYuan(st.paidFen),
              Utils.fenToYuan(st.unpaidFen),
              st.lastDate
            ]);
          });
          return Utils.excelCSV(rows);
        },

        exportPaymentsCSV: function () {
          var rows = [['日期', '学生', '方式', '应收(元)', '实收(元)', '优惠(元)', '记录条数', '备注']];
          api.listPayments({}).slice().reverse().forEach(function (p) {
            rows.push([
              p.date, p.studentName || '', p.method,
              Utils.fenToYuan(p.shouldAmountFen),
              Utils.fenToYuan(p.amountFen),
              Utils.fenToYuan(p.discountFen),
              p.recordIds.length,
              p.note || ''
            ]);
          });
          return Utils.excelCSV(rows);
        },

        /** 批次汇总 CSV（看每一批给多少人打了多少张） */
        exportBatchesCSV: function () {
          var rows = [['日期', '时间', '人数', '学生', '每人张数', '本批总张数', '每人金额(元)', '本批合计(元)', '未结清(元)', '内容/备注']];
          api.batchList({}).slice().reverse().forEach(function (b) {
            rows.push([
              b.date, b.time, b.count, b.studentNames.join('、'),
              b.perSheets, b.sheets,
              Utils.fenToYuan(b.perAmountFen),
              Utils.fenToYuan(b.amountFen),
              Utils.fenToYuan(b.unpaidFen),
              b.note || ''
            ]);
          });
          return Utils.excelCSV(rows);
        },

        /* ---- 演示数据 ---- */

        seedDemoData: function () {
          var today = Utils.todayString();
          var names = [
            ['张小明', '高一(3)班', '20240301'],
            ['李思远', '高一(3)班', '20240302'],
            ['王雨欣', '高一(3)班', '20240303'],
            ['陈浩', '高三(5)班', '20240108']
          ];
          var students = names.map(function (n) {
            try {
              return api.addStudent({ name: n[0], className: n[1], studentNo: n[2] });
            } catch (e) { return null; }
          }).filter(Boolean);
          if (students.length < 4) return false;

          // ① 批量：全班 3 人同样规格（体现批量记账）
          api.addRecordsBatch(
            [students[0].id, students[1].id, students[2].id],
            { sheets: 5, date: Utils.addDays(today, -1), note: '数学周测卷 全班统一' }
          );
          // ② 单条
          api.addRecord({
            studentId: students[3].id,
            date: Utils.addDays(today, -2),
            sheets: 20,
            note: '物理模拟卷'
          });
          api.addRecord({
            studentId: students[0].id,
            date: today,
            sheets: 4,
            note: '英语讲义'
          });
          // ③ 给第一位学生结清历史记录
          var ids = state.records.filter(function (r) {
            return r.studentId === students[0].id && !r.paymentId && r.date < today;
          }).map(function (r) { return r.id; });
          if (ids.length) {
            api.settleRecords(ids, { method: '微信', note: '示例结算' });
          }
          return true;
        }
      };

      return api;
    }

    return {
      SCHEMA_VERSION: SCHEMA_VERSION,
      DEFAULT_KEY: DEFAULT_KEY,
      DEFAULT_SETTINGS: DEFAULT_SETTINGS,
      PAY_METHODS: PAY_METHODS,
      create: createStore,
      normalizeState: normalizeState,
      emptyState: emptyState
    };
  });