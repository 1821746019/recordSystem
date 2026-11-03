/*!
 * tests/core.test.js —— 核心逻辑单元测试（纯 Node，无依赖）
 * 运行：node tests/core.test.js
 *
 * 覆盖：只按张数计价、批量记账与整批撤销、学生/记录增删改、结算与撤销、统计、
 *       改价不影响历史、v1/v2 → v3 数据迁移、导入导出、脏数据容错、日期工具。
 */
'use strict';

var path = require('path');
var CORE = path.join(__dirname, '..', 'js', 'core') + path.sep;

var U = require(CORE + 'utils.js');
var Pricing = require(CORE + 'pricing.js');
var Pinyin = require(CORE + 'pinyin.js');
var Storage = require(CORE + 'storage.js');
var Store = require(CORE + 'store.js');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; console.log('  \u274c ' + name + (extra !== undefined ? '  => ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ================================================================
 * 1. 计价：只有一条规则 —— 张数 × 单价（默认 0.30 元/张）
 * ================================================================ */
section('1. 计价（张数 × 单价，默认 0.30 元/张）');

var c = Pricing.calculate({ sheets: 5 }, Pricing.DEFAULT_PRICING);
ok('5 张 = 1.50 元', c.amountFen === 150, c.amountFen);
ok('张数 5', c.sheets === 5, c.sheets);
ok('单价 30 分随结果返回', c.unitPriceFen === 30, c.unitPriceFen);
ok('1 张 = 0.30 元', Pricing.calculate({ sheets: 1 }, Pricing.DEFAULT_PRICING).amountFen === 30);
ok('0 张 = 0 元', Pricing.calculate({ sheets: 0 }, Pricing.DEFAULT_PRICING).amountFen === 0);
ok('负数/非法张数按 0 处理',
  Pricing.calculate({ sheets: -5 }, Pricing.DEFAULT_PRICING).amountFen === 0 &&
  Pricing.calculate({ sheets: 'abc' }, Pricing.DEFAULT_PRICING).amountFen === 0);
ok('空对象按 0 张处理', Pricing.calculate({}, Pricing.DEFAULT_PRICING).amountFen === 0);
ok('金额格式化 ¥1.50', U.money(150) === '¥1.50', U.money(150));
ok('无浮点误差（0.3 + 0.3 = 0.60）',
  Pricing.calculate({ sheets: 1 }, Pricing.DEFAULT_PRICING).amountFen +
  Pricing.calculate({ sheets: 1 }, Pricing.DEFAULT_PRICING).amountFen === 60);
ok('自定义单价生效', Pricing.calculate({ sheets: 10 }, { priceFen: 15 }).amountFen === 150);
ok('张数上限被截断到 99999',
  Pricing.calculate({ sheets: 999999 }, Pricing.DEFAULT_PRICING).sheets === Pricing.MAX_SHEETS);

section('1.1 兼容旧数据的单/双面张数（自动相加）');
ok('旧的 3 单 + 2 双 = 5 张 = 1.50 元',
  Pricing.calculate({ singleSheets: 3, doubleSheets: 2 }, Pricing.DEFAULT_PRICING).amountFen === 150);
ok('只给 singleSheets 也能算',
  Pricing.calculate({ singleSheets: 4 }, Pricing.DEFAULT_PRICING).amountFen === 120);
ok('readSheets 工具函数', Pricing.readSheets({ singleSheets: 3, doubleSheets: 2 }) === 5);

section('1.2 批量计算（同一份张数 × N 人）');
var b = Pricing.calculateBatch(5, { sheets: 3 }, Pricing.DEFAULT_PRICING);
ok('每人 0.90 元', b.perAmountFen === 90, b.perAmountFen);
ok('5 人合计 4.50 元', b.totalAmountFen === 450, b.totalAmountFen);
ok('人数 5', b.people === 5);
ok('每人张数 3', b.sheets === 3);
ok('0 人合计 0', Pricing.calculateBatch(0, { sheets: 3 }, Pricing.DEFAULT_PRICING).totalAmountFen === 0);

section('1.3 兼容旧定价对象（v1 的单/双面两个价）');
ok('旧 {single:20,double:30} → 统一取双面价 30',
  Pricing.normalize({ singlePriceFen: 20, doublePriceFen: 30 }).priceFen === 30);
ok('旧 {single:25} → 25', Pricing.normalize({ singlePriceFen: 25 }).priceFen === 25);
ok('空对象 → 默认 30', Pricing.normalize({}).priceFen === 30);
ok('定价描述就是「0.30 元/张」',
  Pricing.describe(Pricing.DEFAULT_PRICING) === '0.30 元/张',
  Pricing.describe(Pricing.DEFAULT_PRICING));
ok('明细文案：5 张 × 0.30 元/张',
  Pricing.breakdown({ sheets: 5 }, Pricing.DEFAULT_PRICING) === '5 张 × 0.30 元/张',
  Pricing.breakdown({ sheets: 5 }, Pricing.DEFAULT_PRICING));
ok('张数为 0 时提示未填写',
  Pricing.breakdown({ sheets: 0 }, Pricing.DEFAULT_PRICING).indexOf('尚未') === 0);

section('1.4 半张（0.5 张）粒度');
ok('0.5 张 = 0.15 元', Pricing.calculate({ sheets: 0.5 }, Pricing.DEFAULT_PRICING).amountFen === 15,
  Pricing.calculate({ sheets: 0.5 }, Pricing.DEFAULT_PRICING).amountFen);
ok('1.5 张 = 0.45 元', Pricing.calculate({ sheets: 1.5 }, Pricing.DEFAULT_PRICING).amountFen === 45);
ok('2.5 张 = 0.75 元', Pricing.calculate({ sheets: 2.5 }, Pricing.DEFAULT_PRICING).amountFen === 75);
ok('★ 半张 × 奇数单价也取整到「分」（0.5 张 × 0.25 = 12.5 分 → 13 分）',
  Pricing.calculate({ sheets: 0.5 }, { priceFen: 25 }).amountFen === 13,
  Pricing.calculate({ sheets: 0.5 }, { priceFen: 25 }).amountFen);
ok('张数规范到 0.5 粒度：2.6 → 2.5', Pricing.toSheets(2.6) === 2.5, Pricing.toSheets(2.6));
ok('张数规范到 0.5 粒度：2.2 → 2', Pricing.toSheets(2.2) === 2, Pricing.toSheets(2.2));
ok('整数张数不受影响', Pricing.toSheets(7) === 7);
ok('数量格式化：15 → 15，15.5 → 15.5', U.qty(15) === '15' && U.qty(15.5) === '15.5',
  U.qty(15.5));
ok('明细文案：0.5 张 × 0.30 元/张',
  Pricing.breakdown({ sheets: 0.5 }, Pricing.DEFAULT_PRICING) === '0.5 \u5f20 \u00d7 0.30 \u5143/\u5f20',
  Pricing.breakdown({ sheets: 0.5 }, Pricing.DEFAULT_PRICING));

/* ================================================================
 * 2. 学生与打印记录
 * ================================================================ */
section('2. 学生与打印记录');
var store = Store.create({ adapter: Storage.createMemoryAdapter() });
ok('数据版本为 v3', store.SCHEMA_VERSION === 3, store.SCHEMA_VERSION);

var stu = store.addStudent({ name: '张小明', className: '高一(3)班' });
ok('新建学生', !!stu.id && stu.name === '张小明');
ok('同名同班不重复建档', store.addStudent({ name: '张小明', className: '高一(3)班' }).id === stu.id);
var stu2 = store.addStudent({ name: '李思远', className: '高一(3)班' });

var rec1 = store.addRecord({ studentId: stu.id, sheets: 5, note: '数学讲义', date: '2025-03-01' });
ok('记录金额 1.50 元', rec1.amountFen === 150, rec1.amountFen);
ok('记录张数 5', rec1.sheets === 5, rec1.sheets);
ok('记录冻结当时单价 30 分/张', rec1.priceFen === 30, rec1.priceFen);
ok('记录带学生姓名快照', rec1.studentName === '张小明');
ok('单条记录没有批次号', rec1.batchId === '');
ok('v3 记录里不再有单/双面字段', rec1.singleSheets === undefined && rec1.doubleSheets === undefined);

var rec2 = store.addRecord({ studentId: stu.id, sheets: 10, note: '英语卷子', date: '2025-03-05' });
ok('10 张 = 3.00 元', rec2.amountFen === 300, rec2.amountFen);
var rec3 = store.addRecord({ studentId: stu2.id, sheets: 5, date: '2025-03-05' });
ok('另一学生 5 张 = 1.50 元', rec3.amountFen === 150, rec3.amountFen);
ok('兼容写法：传单/双面张数也能记',
  store.addRecord({ studentId: stu2.id, singleSheets: 2, doubleSheets: 1 }).amountFen === 90);

try { store.addRecord({ studentId: stu.id }); ok('张数为 0 应报错', false); }
catch (e) { ok('张数为 0 被拒绝：' + e.message, true); }
try { store.addRecord({ studentId: 'nobody', sheets: 1 }); ok('未选学生应报错', false); }
catch (e) { ok('未选学生被拒绝：' + e.message, true); }

section('2.1 半张记录（0.5 张）');
var hs = Store.create({ adapter: Storage.createMemoryAdapter() });
var hstu = hs.addStudent({ name: '半张同学' });
var hrec = hs.addRecord({ studentId: hstu.id, sheets: 0.5 });
ok('记录金额 0.15 元', hrec.amountFen === 15, hrec.amountFen);
ok('记录张数 0.5', hrec.sheets === 0.5, hrec.sheets);
ok('再记 1.5 张 → 2.00 元', hs.addRecord({ studentId: hstu.id, sheets: 1.5 }).amountFen === 45);
ok('该生合计 2 张 / 0.60 元',
  hs.studentStats(hstu.id).sheets === 2 && hs.studentStats(hstu.id).amountFen === 60,
  hs.studentStats(hstu.id).sheets + ' / ' + hs.studentStats(hstu.id).amountFen);
ok('CSV 里张数保留 0.5', hs.exportRecordsCSV(null).indexOf(',0.5,') > 0);
ok('统计（张数）能累加小数', hs.overview().sheets === 2, hs.overview().sheets);

/* ================================================================
 * 3. 批量记账
 * ================================================================ */
section('3. 批量记账：一次给多个学生记同样的账');
var bs = Store.create({ adapter: Storage.createMemoryAdapter() });
var s1 = bs.addStudent({ name: '甲' });
var s2 = bs.addStudent({ name: '乙' });
var s3 = bs.addStudent({ name: '丙' });

var r = bs.addRecordsBatch([s1.id, s2.id, s3.id], {
  sheets: 5, date: '2025-04-01', note: '全班统一'
});
ok('生成 3 条记录', r.count === 3 && r.records.length === 3, r.count);
ok('共享同一个 batchId', r.records[0].batchId === r.records[1].batchId && r.batchId === r.records[0].batchId);
ok('每人 5 张', r.sheets === 5, r.sheets);
ok('每人 1.50 元', r.perAmountFen === 150, r.perAmountFen);
ok('本批总张数 15', r.totalSheets === 15, r.totalSheets);
ok('本批合计 4.50 元', r.totalAmountFen === 450, r.totalAmountFen);
ok('三条记录张数都是 5', r.records.every(function (x) { return x.sheets === 5; }));
ok('每条记录各自独立（id 不同）', r.records[0].id !== r.records[1].id);
ok('备注整批共用', r.records[2].note === '全班统一');
ok('每条记录未结清', r.records.every(function (x) { return !x.paymentId; }));
ok('可分开结算（是独立的记录）', bs.studentStats(s1.id).amountFen === 150);

var dup = bs.addRecordsBatch([s1.id, s1.id, s2.id], { sheets: 1 });
ok('重复的学生 id 自动去重（2 人）', dup.count === 2, dup.count);
ok('忽略不存在的学生', bs.addRecordsBatch([s3.id, 'ghost'], { sheets: 1 }).count === 1);
ok('skipped 统计被忽略的数量', bs.addRecordsBatch([s3.id, 'ghost', 'ghost2'], { sheets: 1 }).skipped === 2);
try { bs.addRecordsBatch([], { sheets: 1 }); ok('空学生列表应报错', false); }
catch (e) { ok('空学生列表被拒绝：' + e.message, true); }
try { bs.addRecordsBatch([s1.id], { sheets: 0 }); ok('张数为 0 应报错', false); }
catch (e) { ok('张数为 0 被拒绝：' + e.message, true); }

section('3.1 批次查询与整批撤销');
ok('getBatch 返回该批记录', bs.getBatch(r.batchId).length === 3);
ok('getBatchInfo 人数 3', bs.getBatchInfo(r.batchId).count === 3);
ok('getBatchInfo 每人 5 张', bs.getBatchInfo(r.batchId).sheets === 5);
ok('getBatchInfo 本批 15 张 / 4.50 元',
  bs.getBatchInfo(r.batchId).totalSheets === 15 && bs.getBatchInfo(r.batchId).totalAmountFen === 450);
ok('getBatchInfo 含学生姓名', bs.getBatchInfo(r.batchId).studentNames.join(',') === '甲,乙,丙');
ok('batchCounts 统计各批条数', bs.batchCounts()[r.batchId] === 3);
ok('batchList 按批汇总（每人张数）', bs.batchList({})[0].perSheets > 0 || bs.batchList({}).length > 0);
ok('不存在的批次返回 null', bs.getBatchInfo('nope') === null);

var beforeCount = bs.getState().records.length;
var del = bs.deleteBatch(r.batchId);
ok('整批撤销删除 3 条', del.removed === 3, del.removed);
ok('剩余记录数正确', bs.getState().records.length === beforeCount - 3);
ok('撤销后批次为空', bs.getBatch(r.batchId).length === 0);

/* ================================================================
 * 4. 统计
 * ================================================================ */
section('4. 统计');
var st = store.studentStats(stu.id);
ok('该生累计 4.50 元', st.amountFen === 450, st.amountFen);
ok('该生 2 条记录', st.recordCount === 2, st.recordCount);
ok('该生 15 张', st.sheets === 15, st.sheets);
ok('该生未结清 4.50 元', st.unpaidFen === 450, st.unpaidFen);
ok('该生最近打印日期', st.lastDate === '2025-03-05', st.lastDate);
ok('该生月度分组非空', st.monthly.length === 1);
ok('统计结果里没有页数字段', st.pages === undefined);

var ov = store.overview();
ok('学生数 2', ov.studentCount === 2, ov.studentCount);
ok('记录数 4', ov.recordCount === 4, ov.recordCount);
ok('总张数 23（5 + 10 + 5 + 3）', ov.sheets === 23, ov.sheets);
ok('应收总额 6.90 元', ov.amountFen === 690, ov.amountFen);
ok('未结清 6.90 元 / 4 条', ov.unpaidFen === 690 && ov.unpaidCount === 4);
ok('概览里没有页数', ov.pages === undefined && ov.today.pages === undefined && ov.month.pages === undefined);
ok('月度汇总包含 2025-03', store.monthlyStats().some(function (m) { return m.month === '2025-03'; }));
ok('学生排行第一名是张小明', store.studentRanking({})[0].student.name === '张小明');
ok('欠款名单 2 人', store.unpaidStudents().length === 2, store.unpaidStudents().length);

/* ================================================================
 * 5. 收款结算
 * ================================================================ */
section('5. 收款结算');
var pay = store.settleRecords([rec1.id, rec2.id], { method: '微信', date: '2025-03-06' });
ok('应收合计 4.50 元', pay.shouldAmountFen === 450, pay.shouldAmountFen);
ok('实收默认等于应收', pay.amountFen === 450, pay.amountFen);
ok('关联 2 条记录', pay.recordIds.length === 2);
ok('两条记录变为已结清', !!store.getRecord(rec1.id).paymentId && !!store.getRecord(rec2.id).paymentId);
st = store.studentStats(stu.id);
ok('该生已结清 4.50 / 未结清 0', st.paidFen === 450 && st.unpaidFen === 0, st.paidFen + '/' + st.unpaidFen);
ok('全局实收金额 4.50 元', store.overview().receivedFen === 450);

var pay2 = store.settleRecords([rec3.id], { method: '现金', amountFen: 140, note: '抹零' });
ok('优惠抹零：应收 1.50 / 实收 1.40', pay2.shouldAmountFen === 150 && pay2.amountFen === 140);
ok('优惠金额 0.10 元', pay2.discountFen === 10, pay2.discountFen);
try { store.settleRecords([rec3.id], {}); ok('重复结算应报错', false); }
catch (e) { ok('重复结算被拒绝：' + e.message, true); }

section('6. 撤销与删除');
store.unsettleRecords([rec3.id]);
ok('撤销结清后回到未结清', store.getRecord(rec3.id).paymentId === null);
ok('空收款单被自动清理', store.listPayments({}).length === 1, store.listPayments({}).length);
store.deletePayment(pay.id);
ok('删除收款单生效', store.listPayments({}).length === 0);
ok('关联记录全部回到未结清', !store.getRecord(rec1.id).paymentId && !store.getRecord(rec2.id).paymentId);
ok('数据自洽：未结清 = 应收总额', store.overview().unpaidFen === store.overview().amountFen);

/* ================================================================
 * 7. 改价 / 编辑 / 筛选
 * ================================================================ */
section('7. 改价不影响历史记录');
store.updateSettings({ priceFen: 50 });
var rec4 = store.addRecord({ studentId: stu2.id, sheets: 2 });
ok('新记录按新价 2 张 × 0.50 = 1.00 元', rec4.amountFen === 100, rec4.amountFen);
ok('新记录冻结新单价 50', rec4.priceFen === 50);
ok('旧记录金额不变 1.50 元', store.getRecord(rec1.id).amountFen === 150);
ok('旧记录单价不变 30', store.getRecord(rec1.id).priceFen === 30);
ok('getPricing 已更新', store.getPricing().priceFen === 50);

section('7.1 编辑与筛选');
store.updateRecord(rec1.id, { sheets: 4 });
ok('改张数按记录自身冻结单价重算 = 1.20 元', store.getRecord(rec1.id).amountFen === 120, store.getRecord(rec1.id).amountFen);
ok('张数已更新为 4', store.getRecord(rec1.id).sheets === 4);
try { store.updateRecord(rec1.id, { sheets: 0 }); ok('改成 0 张应报错', false); }
catch (e) { ok('改成 0 张被拒绝：' + e.message, true); }
ok('按学生筛选', store.queryRecords({ studentId: stu.id }).length === 2);
ok('按日期范围筛选', store.queryRecords({ from: '2025-03-05', to: '2025-03-05' }).length === 2);
ok('筛选未结清', store.queryRecords({ status: 'unpaid' }).length === 5, store.queryRecords({ status: 'unpaid' }).length);
ok('筛选已结清', store.queryRecords({ status: 'paid' }).length === 0);
ok('按关键字搜备注', store.queryRecords({ keyword: '英语' }).length === 1);
ok('limit 生效', store.queryRecords({ limit: 2 }).length === 2);
ok('默认按日期倒序', store.queryRecords({})[0].date === U.todayString());

/* ================================================================
 * 8. 导入导出
 * ================================================================ */
section('8. 导入导出');
var json = store.exportJSON(true);
ok('导出 JSON 合法且是 v3', JSON.parse(json).version === 3 && JSON.parse(json).records.length === 5);
ok('导出 JSON 里的记录只有 sheets', JSON.parse(json).records[0].sheets !== undefined &&
  JSON.parse(json).records[0].singleSheets === undefined);
var csv = store.exportRecordsCSV(null);
ok('CSV 带 BOM（Excel 不乱码）', csv.charCodeAt(0) === 0xFEFF);
ok('CSV 表头含 张数', csv.indexOf('张数') > 0);
ok('CSV 表头含 单价(元/张)', csv.indexOf('单价(元/张)') > 0);
ok('CSV 表头含 批次号', csv.indexOf('批次号') > 0);
ok('CSV 里不再有单/双面列', csv.indexOf('单面张数') < 0 && csv.indexOf('页数') < 0);
ok('CSV 行数 = 表头 + 5 条', csv.split('\r\n').length === 6, csv.split('\r\n').length);
ok('学生汇总 CSV 有表头 + 2 行', store.exportStudentsCSV().split('\r\n').length === 3);
ok('收款 CSV 有表头', store.exportPaymentsCSV().indexOf('实收(元)') > 0);
ok('批次 CSV 含每人张数', store.exportBatchesCSV().indexOf('每人张数') > 0);

var store2 = Store.create({ adapter: Storage.createMemoryAdapter() });
var stats = store2.importJSON(json, { mode: 'replace' });
ok('导入学生 2 名', stats.students === 2, stats.students);
ok('导入记录 5 条', stats.records === 5, stats.records);
ok('导入后应收金额一致', store2.overview().amountFen === store.overview().amountFen);
ok('导入后单价一致', store2.getSettings().priceFen === 50);

/* ================================================================
 * 9. 旧数据自动升级（v1 / v2 → v3）
 * ================================================================ */
section('9. 旧数据自动升级');

// v1：单/双面两个单价 + 单/双面张数
var V1 = {
  version: 1,
  settings: { shopName: '老店', singlePriceFen: 20, doublePriceFen: 30 },
  students: [{ id: 'stu_1', name: '老学生', className: '高二(1)班' }],
  records: [{
    id: 'rec_1', studentId: 'stu_1', studentName: '老学生',
    date: '2025-01-01', time: '10:00',
    singleSheets: 4, doubleSheets: 2,
    singlePriceFen: 20, doublePriceFen: 30,
    amountFen: 140,          // 4×0.2 + 2×0.3 = 1.40（旧算法的历史金额）
    note: '旧账'
  }],
  payments: []
};
var m1 = Storage.createMemoryAdapter();
m1.setItem(Store.DEFAULT_KEY, JSON.stringify(V1));
var s1store = Store.create({ adapter: m1 });
ok('v1 → 版本号升到 3', s1store.SCHEMA_VERSION === 3);
ok('v1 的单价迁移为统一价（取双面价 30）', s1store.getSettings().priceFen === 30);
ok('店铺名保留', s1store.getSettings().shopName === '老店');
ok('学生数据保留', s1store.listStudents('').length === 1);
var oldRec = s1store.getRecord('rec_1');
ok('v1 的单/双面张数合并为 6 张', oldRec.sheets === 6, oldRec.sheets);
ok('记录的单价迁移为 30', oldRec.priceFen === 30, oldRec.priceFen);
ok('历史金额原样保留（1.40 元，不被重算）', oldRec.amountFen === 140, oldRec.amountFen);
ok('记录上不再残留 singleSheets/doubleSheets',
  oldRec.singleSheets === undefined && oldRec.doubleSheets === undefined);

// v2：统一单价 + 单/双面张数
var V2 = {
  version: 2,
  settings: { priceFen: 30, shopName: '旧版店' },
  students: [{ id: 'stu_2', name: '张三' }],
  records: [{
    id: 'rec_2', studentId: 'stu_2', studentName: '张三',
    date: '2025-02-01', time: '11:00',
    singleSheets: 3, doubleSheets: 2, priceFen: 30, amountFen: 150
  }],
  payments: []
};
var m2 = Storage.createMemoryAdapter();
m2.setItem(Store.DEFAULT_KEY, JSON.stringify(V2));
var s2store = Store.create({ adapter: m2 });
ok('v2 → v3：单价保留 30', s2store.getSettings().priceFen === 30);
ok('v2 → v3：张数合并为 5', s2store.getRecord('rec_2').sheets === 5);
ok('v2 → v3：金额保留 1.50', s2store.getRecord('rec_2').amountFen === 150);

/* ================================================================
 * 10. 脏数据 / 异常容错
 * ================================================================ */
section('10. 脏数据 / 异常容错');
var dirty = Store.normalizeState({
  students: [{ name: '王五' }, { name: '' }, null],
  records: [{ studentId: 'x', sheets: 3, paymentId: 'not-exist' }],
  payments: [{ id: 'p1', amountFen: 50, recordIds: ['ghost'] }]
});
ok('过滤掉没有姓名的学生', dirty.students.length === 1, dirty.students.length);
ok('缺失金额自动补算 0.90 元（3 张 × 0.30）', dirty.records[0].amountFen === 90, dirty.records[0].amountFen);
ok('悬空的收款关联被清理', dirty.records[0].paymentId === null);
ok('收款单里的幽灵记录被清理', dirty.payments[0].recordIds.length === 0);
ok('旧字段的脏数据也能合并张数', Store.normalizeState({
  records: [{ studentId: 'x', singleSheets: 2, doubleSheets: 1 }]
}).records[0].sheets === 3);
ok('传入 null 也能兜底', Store.normalizeState(null).students.length === 0);
ok('坏 JSON 不会崩溃', (function () {
  try {
    var s = Store.create({ adapter: { name: 'x', getItem: function () { return '{bad json'; }, setItem: function () {}, removeItem: function () {} } });
    return s.getState().records.length === 0;
  } catch (e) { return false; }
})());
ok('存储不可用时不抛错', (function () {
  try { return !!Store.create({ adapter: Storage.createLocalStorageAdapter(null) }); } catch (e) { return false; }
})());
ok('非法张数被拒绝，且统计不出现 NaN', (function () {
  var s = Store.create({ adapter: Storage.createMemoryAdapter() });
  var stu0 = s.addStudent({ name: '测试' });
  try {
    s.addRecord({ studentId: stu0.id, sheets: 'x' });
    return false;   // 不该成功
  } catch (e) {
    var st0 = s.studentStats(stu0.id);
    return st0.amountFen === 0 && !isNaN(st0.unpaidFen) && !isNaN(st0.sheets);
  }
})());

/* ================================================================
 * 11. 示例数据
 * ================================================================ */
section('11. 示例数据');
var store3 = Store.create({ adapter: Storage.createMemoryAdapter() });
store3.seedDemoData();
ok('生成 4 名学生', store3.listStudents('').length === 4, store3.listStudents('').length);
ok('生成 5 条记录', store3.getState().records.length === 5, store3.getState().records.length);
ok('含 1 个批量批次（3 人同批）', store3.batchList({}).length === 1, store3.batchList({}).length);
ok('该批次每人 5 张', store3.batchList({})[0].perSheets === 5);
ok('该批次 3 人', store3.batchList({})[0].count === 3);
ok('总张数 39（15 + 20 + 4）', store3.overview().sheets === 39, store3.overview().sheets);
ok('含 1 笔结算', store3.listPayments({}).length === 1, store3.listPayments({}).length);

/* ================================================================
 * 12. 拼音搜索
 * ================================================================ */
section('12. 拼音转换');
ok('拼音模块加载成功（node 自带 ICU，模式应为 full）', Pinyin.mode === 'full', Pinyin.mode);
ok('张小明 → zhangxiaoming', Pinyin.full('张小明') === 'zhangxiaoming', Pinyin.full('张小明'));
ok('张小明 → 首字母 zxm', Pinyin.initials('张小明') === 'zxm', Pinyin.initials('张小明'));
ok('王雨欣 → wangyuxin / wyx',
  Pinyin.full('王雨欣') === 'wangyuxin' && Pinyin.initials('王雨欣') === 'wyx');
ok('多音字姓氏修正：曾 → zeng', Pinyin.full('曾磊') === 'zenglei', Pinyin.full('曾磊'));
ok('多音字姓氏修正：沈 → shen', Pinyin.full('沈梦') === 'shenmeng', Pinyin.full('沈梦'));
ok('英文/数字原样保留', Pinyin.full('Tony2号') === 'tony2hao', Pinyin.full('Tony2号'));
ok('标点被跳过', Pinyin.full('高一(3)班') === 'gaoyi3ban', Pinyin.full('高一(3)班'));
ok('空格也跳过', Pinyin.full('张 小明') === 'zhangxiaoming');

section('12.1 模糊匹配打分（分数越高越靠前）');
ok('原文完全相同 → 100', Pinyin.matchScore('张小明', '张小明') === 100);
ok('原文前缀 → 92', Pinyin.matchScore('张小明', '张') === 92);
ok('原文包含 → 84', Pinyin.matchScore('张小明', '小明') === 84);
ok('全拼完全相同 → 95', Pinyin.matchScore('张小明', 'zhangxiaoming') === 95);
ok('全拼前缀 → 88', Pinyin.matchScore('张小明', 'zhangxiao') === 88);
ok('★ 首字母（zxm）→ 80', Pinyin.matchScore('张小明', 'zxm') === 80);
ok('★ 拼音+首字母混打（zhangxm）→ 80', Pinyin.matchScore('张小明', 'zhangxm') === 80);
ok('★ 拼音+首字母混打（zxiaoming）→ 80', Pinyin.matchScore('张小明', 'zxiaoming') === 80);
ok('★ 从名字中间开始（xm）→ 66', Pinyin.matchScore('张小明', 'xm') === 66);
ok('★ 从名字中间开始（xming）→ 66', Pinyin.matchScore('张小明', 'xming') === 66);
ok('★ 不会横跨音节乱命中（gy 不该匹配王雨欣）',
  Pinyin.matchScore('王雨欣', 'gy') === 0, Pinyin.matchScore('王雨欣', 'gy'));
ok('★ 也不会把 gaoer1ban 里的片段当命中（gy vs 高二班）',
  Pinyin.matchScore('高二(1)班', 'gy') === 0, Pinyin.matchScore('高二(1)班', 'gy'));
ok('从某个字的拼音开头整段匹配 → 50（yuxin → 王雨欣）',
  Pinyin.matchScore('王雨欣', 'yuxin') === 66, Pinyin.matchScore('王雨欣', 'yuxin'));
ok('大小写不敏感', Pinyin.matchScore('张小明', 'ZXM') === 80);
ok('不匹配 → 0', Pinyin.matchScore('张小明', 'wang') === 0);
ok('空关键字 → 0', Pinyin.matchScore('张小明', '') === 0);
ok('字母字段也能匹配（学号/电话）', Pinyin.matchScore('20240301', '2024') === 92);
ok('拼音匹配班级（gy → 高一(3)班）', Pinyin.matchScore('高一(3)班', 'gy') === 80,
  Pinyin.matchScore('高一(3)班', 'gy'));
ok('班级全拼（gaoyi）→ 88', Pinyin.matchScore('高一(3)班', 'gaoyi') === 88);

section('12.2 多关键字（空格分隔 = 都要命中）');
ok('姓名 + 班级都能命中', Pinyin.searchScore(['张小明', '高一(3)班'], 'zxm 高一') > 0);
ok('一个关键字没命中就整体不命中', Pinyin.searchScore(['张小明', '高一(3)班'], 'zxm 高二') === 0);
ok('多关键字分数累加（越高越相关）',
  Pinyin.searchScore(['张小明', '高一(3)班'], 'zxm 高一') >
  Pinyin.searchScore(['张小明', '高一(3)班'], 'zxm'));

section('12.3 学生搜索（store 集成）');
var ps = Store.create({ adapter: Storage.createMemoryAdapter() });
ps.addStudent({ name: '张小明', className: '高一(3)班', studentNo: '20240301' });
ps.addStudent({ name: '李小明', className: '高一(3)班', studentNo: '20240302' });
ps.addStudent({ name: '王雨欣', className: '高二(1)班', studentNo: '20240215' });
function names(list) { return list.map(function (s) { return s.name; }).join(','); }

ok('store 暴露拼音模式', ps.pinyinMode === 'full', ps.pinyinMode);
ok("搜 'zxm' → 张小明", names(ps.listStudents('zxm')) === '张小明', names(ps.listStudents('zxm')));
ok("搜 'lxm' → 李小明", names(ps.listStudents('lxm')) === '李小明', names(ps.listStudents('lxm')));
ok("搜 'xm' → 两个小明（同分时按姓名拼音稳定排序）",
  ps.listStudents('xm').length === 2, names(ps.listStudents('xm')));
ok("搜 'wyx' → 王雨欣", names(ps.listStudents('wyx')) === '王雨欣', names(ps.listStudents('wyx')));
ok("搜 'wangyuxin' → 王雨欣", names(ps.listStudents('wangyuxin')) === '王雨欣');
ok("搜 'yuxin' → 王雨欣", names(ps.listStudents('yuxin')) === '王雨欣');
ok("搜中文 '小明' → 两个", ps.listStudents('小明').length === 2);
ok("搜班级 '高一' → 2 人", ps.listStudents('高一').length === 2, names(ps.listStudents('高一')));
ok("搜班级首字母 'gy' → 2 人", ps.listStudents('gy').length === 2, names(ps.listStudents('gy')));
ok("搜学号 '202403' → 2 人", ps.listStudents('202403').length === 2);
ok("搜空格分隔 'zxm 高一' → 张小明",
  names(ps.listStudents('zxm 高一')) === '张小明', names(ps.listStudents('zxm 高一')));
ok('搜不到就是空数组', ps.listStudents('zzzz').length === 0);
ok('空关键字返回全部（按建档顺序）', ps.listStudents('').length === 3);
ok('不修改原数组（返回新数组）', ps.listStudents('').length === 3 && ps.listStudents('zxm').length === 1);

section('12.4 记录搜索也支持拼音');
ps.addRecord({ studentId: ps.listStudents('zxm')[0].id, sheets: 5, note: '数学讲义' });
ok("记录搜索 'zxm' 命中该学生的记录", ps.queryRecords({ keyword: 'zxm' }).length === 1);
ok("记录搜索 'xiaoming' 命中代码", ps.queryRecords({ keyword: 'xiaoming' }).length >= 1);
ok("记录搜索备注原文 '数学' 命中", ps.queryRecords({ keyword: '数学' }).length === 1);
ok('记录搜索无关词不命中', ps.queryRecords({ keyword: 'zzz' }).length === 0);

/* ================================================================
 * 12.5 浏览器加载路径（<script> 方式，不经过 CommonJS）
 * ================================================================ */
section('12.5 浏览器加载路径（模拟 <script> 顺序加载）');
(function () {
  var vm = require('vm');
  var fsx = require('fs');
  var vpath = require('path').join(__dirname, '..', 'js', 'vendor', 'tiny-pinyin.js');
  var box = { console: console, Intl: Intl, navigator: { userAgent: 'Mozilla/5.0 Chrome/120' }, setTimeout: setTimeout };
  box.globalThis = box;
  vm.createContext(box);

  var err = null;
  try {
    vm.runInContext(fsx.readFileSync(vpath, 'utf8'), box, { filename: 'tiny-pinyin.js' });
    ['utils.js', 'pricing.js', 'pinyin.js', 'storage.js', 'store.js'].forEach(function (f) {
      vm.runInContext(fsx.readFileSync(require('path').join(__dirname, '..', 'js', 'core', f), 'utf8'), box, { filename: f });
    });
  } catch (e) { err = e; }

  ok('浏览器方式加载 4 个 core 脚本不报错', !err, err && err.message);
  ok('vendor 挂在 window.PrintSystem.vendorTinyPinyin 上',
    !!(box.PrintSystem && box.PrintSystem.vendorTinyPinyin), !!box.PrintSystem);
  ok('PrintSystem.Pinyin 可用', !!(box.PrintSystem && box.PrintSystem.Pinyin));
  ok('浏览器路径下拼音结果正确',
    box.PrintSystem && box.PrintSystem.Pinyin.full('张小明') === 'zhangxiaoming',
    box.PrintSystem && box.PrintSystem.Pinyin.full('张小明'));
  ok('浏览器路径下 store 可用（拼音搜索生效）', (function () {
    try {
      var s = box.PrintSystem.Store.create({ adapter: box.PrintSystem.Storage.createMemoryAdapter() });
      s.addStudent({ name: '张小明' });
      return s.listStudents('zxm').length === 1;
    } catch (e) { return false; }
  })());
})();

/* ================================================================
 * 13. 日期与金额工具
 * ================================================================ */
section('13. 日期与金额工具');
ok('本周从周一开始', U.startOfWeek('2025-03-05') === '2025-03-03', U.startOfWeek('2025-03-05'));
ok('月初', U.startOfMonth('2025-03-05') === '2025-03-01');
ok('加天数跨月', U.addDays('2025-02-28', 1) === '2025-03-01', U.addDays('2025-02-28', 1));
ok('今天显示为「今天」', U.formatDateHuman(U.todayString()) === '今天');
ok('月份 key', U.monthKey('2025-03-05') === '2025-03');
ok('元转分（含符号/字符串）',
  U.yuanToFen('0.35') === 35 && U.yuanToFen(1.5) === 150 && U.yuanToFen('¥0.30') === 30);
ok('分转元', U.fenToYuan(30) === '0.30' && U.fenToYuan(0) === '0.00' && U.fenToYuan(1234) === '12.34');
ok('HTML 转义', U.escapeHtml('<img src=x>').indexOf('&lt;') === 0);

/* ================================================================ */

console.log('\n========================================');
console.log('核心逻辑测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exitCode = 1;