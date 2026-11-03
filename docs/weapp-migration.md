# 迁移到微信小程序 · 完整指南

> 本项目在设计时就为这次迁移做了准备：**`js/core/` 里的代码一行都不用改**。
> 需要重写的只有界面层（`js/ui/` → WXML/WXSS/Page）。
>
> 💡 **先确认一下真的需要小程序吗？** 如果目标只是「手机上离线记账」，
> 现在的网页版已经是 PWA：装到桌面即可离线使用、全屏无地址栏，
> **不需要备案、不需要审核、不需要开发者工具**（见 README 第十节）。
> 小程序的优势主要在「分享给别的老师用」「不用装到桌面」。

---

## 0. 为什么可以直接搬

| 小程序的要求 | 本项目的做法 |
| --- | --- |
| 没有 `window` / `document` | `js/core/` 里完全不碰 DOM |
| 需要 CommonJS `require` | 每个文件都是 UMD，`module.exports` 已经写好 |
| 存储要用 `wx.setStorageSync` | 存储做了适配器，`createWxStorageAdapter(wx)` 已内置 |
| 不能用 `localStorage` | 业务层只依赖 `getItem / setItem / removeItem` 三个方法 |
| 界面靠 `setData` 驱动 | 数据层有 `store.subscribe(fn)` 发布订阅 |

---

## 1. 目标目录结构

```
miniprogram/
├── app.js                    ← 初始化 store，挂到 App 实例
├── app.json                  ← tabBar 配置
├── app.wxss                  ← 全局样式（从 css/style.css 抄变量与公共类）
│
├── core/                     ← 直接从原项目复制 js/core/，一个字都不用改
│   ├── utils.js
│   ├── pricing.js
│   ├── pinyin.js             拼音搜索（依赖下面的 vendor）
│   ├── storage.js
│   └── store.js
│
├── vendor/                   ← 也要一起复制（第三方库，已内联成单文件）
│   └── tiny-pinyin.js
│
└── pages/
    ├── quick/    记账页（tab）多选学生 + 批量提交
    ├── records/  记录页（tab）
    ├── students/ 学生页（tab）
    ├── stats/    统计页（tab）
    └── settings/ 设置页（tab）
```

复制命令（在本项目根目录执行）：

```bash
mkdir -p miniprogram
cp -r js/core miniprogram/core
cp -r js/vendor miniprogram/vendor      # 拼音库也要带上（单文件，不用 npm）
```

---

## 2. app.js：唯一的初始化改动

```js
// miniprogram/app.js
const Storage = require('./core/storage.js');
const Store = require('./core/store.js');

// ★ 就是这一行 —— 换了存储适配器，其余全都不变
const store = Store.create({
  adapter: Storage.createWxStorageAdapter(wx)
});

App({
  store: store,

  onLaunch() {
    console.log('数据版本', store.SCHEMA_VERSION, '存储方式', store.storageName);
  },

  onShow() {
    // 从后台切回来时重新读一次缓存，保证多页面数据一致
    this.store.reload();
  }
});
```

## 3. app.json：5 个 tab

```json
{
  "pages": [
    "pages/quick/quick",
    "pages/records/records",
    "pages/students/students",
    "pages/stats/stats",
    "pages/settings/settings"
  ],
  "window": {
    "navigationBarTitleText": "打印记录",
    "navigationBarBackgroundColor": "#4f6ef7",
    "navigationBarTextStyle": "white",
    "backgroundColor": "#f2f4f9"
  },
  "tabBar": {
    "color": "#9aa1ad",
    "selectedColor": "#4f6ef7",
    "list": [
      { "pagePath": "pages/quick/quick",       "text": "记账" },
      { "pagePath": "pages/records/records",   "text": "记录" },
      { "pagePath": "pages/students/students", "text": "学生" },
      { "pagePath": "pages/stats/stats",       "text": "统计" },
      { "pagePath": "pages/settings/settings", "text": "设置" }
    ]
  },
  "style": "v2",
  "sitemapLocation": "sitemap.json"
}
```

> tabBar 图标（`iconPath`）需自己准备 png，放到 `images/` 下再补字段；
> 先跑通功能可以先不配图标（微信允许纯文字的 tabBar）。

---

## 4. 通用套路：把 render() 换成 setData

网页版的思路是「`store` 算出视图数据 → 生成 HTML 字符串」，
小程序里换成「`store` 算出视图数据 → `setData` → WXML 渲染」。

**关键：把所有金额都提前格式化成字符串再 `setData`**，
因为小程序的 WXML 里不能调用任意函数（除非用 WXS）。

```js
// 每个页面都这么写
function buildViewData(store) {
  const ov = store.overview();
  return {
    priceDesc: require('../../core/pricing.js').describe(store.getPricing()),
    unpaidText: require('../../core/utils.js').money(ov.unpaidFen),
    // ...
  };
}
```

---

## 5. 记账页（批量）完整示例

这是最核心的一页：**勾选多个学生 → 填一份张数 → 一次提交**。

### 5.1 quick.wxml

```xml
<view class="card">
  <view class="card-title">
    ① 选择学生
    <text wx:if="{{people}}" class="badge">已选 {{people}} 人</text>
  </view>

  <!-- 搜索框，点一下展开候选（tap 切换选中，不关闭，方便连续多选） -->
  <input class="input" placeholder="输入姓名 / 班级搜索，点一下加入（可多选）"
         value="{{search}}" confirm-type="search"
         bindinput="onSearchInput" bindfocus="onFocus" />

  <!-- 已选学生标签 -->
  <view class="picked">
    <view class="chip" wx:for="{{picked}}" wx:key="id" data-id="{{item.id}}" bindtap="onUnpick">
      {{item.name}}<text class="x">✕</text>
    </view>
    <text wx:if="{{!picked.length}}" class="hint">还没选学生，先搜索并点一下加入</text>
  </view>

  <text class="hint">{{hint}}</text>

  <!-- 候选列表：顶部固定操作条 + 只有学生列表滚动 -->
  <view class="cand" wx:if="{{showCand}}">
    <view class="cand-tools" wx:if="{{showTools}}">
      <button size="mini" type="primary" wx:if="{{candidates.length > 1}}"
              bindtap="onSelectAll">全选这 {{candidates.length}} 人</button>
      <button size="mini" wx:if="{{people}}" bindtap="onClearPicked">清空已选（{{people}}）</button>
    </view>

    <scroll-view class="cand-items" scroll-y>
      <view class="cand-item" wx:for="{{candidates}}" wx:key="id"
            data-id="{{item.id}}" bindtap="onToggle">
        <text class="mark">{{item.checked ? '✓' : ''}}</text>
        <text class="name">{{item.name}}</text>
        <text class="meta">{{item.className}}</text>
        <text class="money">{{item.moneyText}}</text>
      </view>
    </scroll-view>
  </view>
</view>

<view class="card">
  <view class="card-title">② 每人打印了多少张</view>

  <view class="counter">
    <text class="label">🖨️ 张数</text>
    <view class="ctrl">
      <button class="step" data-field="sheets" data-delta="-0.5" bindtap="onStep">−</button>
      <input class="num" type="digit" value="{{sheets}}" data-field="sheets" bindinput="onNumInput" />
      <button class="step" data-field="sheets" data-delta="0.5" bindtap="onStep">＋</button>
    </view>
  </view>

  <text class="hint">这批学生共用同样的张数（支持半张 0.5）；单价 {{priceText}} 元/张，金额 = 张数 × 单价</text>
</view>

<view class="card amount-card">
  <text class="amount-label">每人 {{perAmountText}} × {{people}} 人</text>
  <text class="amount">{{totalAmountText}}</text>
  <text class="amount-sub">{{breakdown}}</text>
  <text class="amount-sub">{{countsText}}</text>
</view>

<view class="card">
  <view class="card-title">③ 补充信息（可不填）</view>
  <picker mode="date" value="{{date}}" bindchange="onDate">
    <view class="input">日期：{{date}}</view>
  </picker>
  <input class="input" placeholder="内容 / 备注（整批共用）" value="{{note}}" bindinput="onNote" />
</view>

<view class="actions">
  <button type="primary" bindtap="onSave">保存记录{{people > 1 ? '（' + people + ' 人）' : ''}}</button>
  <button bindtap="onSaveClear">保存并清空</button>
</view>

<!-- 撤销上一批 -->
<view class="undo" wx:if="{{lastBatchId}}">
  <text>上一批：{{lastCount}} 人 · {{lastTotalText}}</text>
  <button size="mini" bindtap="onUndoBatch">撤销这一批</button>
</view>
```

对应的 WXSS —— 关键是**外层不滚动，只有 `.cand-items` 滚动**，
这样「全选 / 清空」才能一直贴在顶部，学生再多也不用先滚到底：

```css
.cand {
  position: absolute; left: 0; right: 0; top: 100%;
  max-height: 640rpx;
  display: flex; flex-direction: column;   /* 上下两段：工具条 + 滚动区 */
  overflow: hidden;                        /* 让圆角裁掉内部子元素 */
  background: #fff; border-radius: 20rpx;
  box-shadow: 0 24rpx 64rpx rgba(20, 26, 40, .14);
}
.cand-tools {                              /* 顶部固定，不随列表滚动 */
  flex: none;
  display: flex; flex-wrap: wrap; gap: 16rpx;
  padding: 16rpx 18rpx;
  background: #f7f8fc; border-bottom: 1rpx solid #e6e9f0;
}
.cand-items {                              /* 只有这一块滚动 */
  flex: 1 1 auto; min-height: 0; max-height: 528rpx;
}
```

### 5.2 quick.js

```js
// pages/quick/quick.js
const app = getApp();
const store = app.store;
const U = require('../../core/utils.js');
const Pricing = require('../../core/pricing.js');

Page({
  data: {
    // 表单
    search: '', sheets: 0,
    date: '', time: '', note: '',
    // 选择
    picked: [], people: 0, hint: '',
    candidates: [], showCand: false, showTools: false,
    // 金额（已格式化）
    perAmountText: '¥0.00', totalAmountText: '¥0.00',
    breakdown: '', countsText: '', priceText: '0.30',
    // 撤销
    lastBatchId: '', lastCount: 0, lastTotalText: ''
  },

  _selectedIds: [],   // 选中顺序保存在实例上（不参与渲染）

  onLoad() {
    this.setData({ date: U.todayString(), time: U.toTimeString(Date.now()) });
    this.refresh();
    // 数据一变就刷新页面（等价于网页版的 store.subscribe → render）
    this._unsub = store.subscribe(() => this.refresh());
  },

  onUnload() { if (this._unsub) this._unsub(); },

  /* ---------------- 刷新视图数据 ---------------- */
  refresh() {
    const d = this.data;
    const people = this._selectedIds.length;
    const batch = Pricing.calculateBatch(people, d, store.getPricing());

    let hint = '共 ' + store.listStudents('').length + ' 名学生可选择 · 一次可以选多个，共用这份张数';
    if (people) {
      let unpaid = 0;
      this._selectedIds.forEach(id => { unpaid += store.studentStats(id).unpaidFen; });
      hint = '已选 ' + people + ' 人 · 未结清合计 ' + U.money(unpaid);
    }

    this.setData({
      people,
      picked: this._selectedIds.map(id => store.getStudent(id)).filter(Boolean),
      hint,
      perAmountText: U.money(batch.perAmountFen),
      totalAmountText: U.money(batch.totalAmountFen),
      breakdown: Pricing.breakdown(d, store.getPricing()),
      countsText: people
        ? '共 ' + batch.sheets * people + ' 张（每人 ' + batch.sheets + ' 张）'
        : '请先选择学生',
      priceText: U.fenToYuan(store.getPricing().priceFen)
    });
  },

  /* ---------------- 学生多选 ---------------- */
  onFocus() { this.renderCandidates(); this.setData({ showCand: true }); },

  onSearchInput(e) {
    this.setData({ search: e.detail.value });
    this.renderCandidates();
    this.setData({ showCand: true });
  },

  renderCandidates() {
    const kw = (this.data.search || '').trim();
    const list = store.listStudents(kw).map(st => {
      const s = store.studentStats(st.id);
      return {
        id: st.id, name: st.name, className: st.className || st.studentNo,
        checked: this._selectedIds.indexOf(st.id) >= 0,
        moneyText: s.unpaidFen > 0 ? '欠 ' + U.money(s.unpaidFen) : U.money(s.amountFen)
      };
    });
    // 顶部操作条只在「有多个结果」或「已经选过人」时才显示，避免占地方
    const showTools = list.length > 1 || this._selectedIds.length > 0;
    this.setData({ candidates: list, showTools });
  },

  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const i = this._selectedIds.indexOf(id);
    if (i >= 0) this._selectedIds.splice(i, 1);
    else this._selectedIds.push(id);
    this.renderCandidates();
    this.refresh();
  },

  onUnpick(e) {
    const id = e.currentTarget.dataset.id;
    const i = this._selectedIds.indexOf(id);
    if (i >= 0) this._selectedIds.splice(i, 1);
    this.renderCandidates();
    this.refresh();
  },

  onSelectAll() {
    store.listStudents((this.data.search || '').trim()).forEach(st => {
      if (this._selectedIds.indexOf(st.id) < 0) this._selectedIds.push(st.id);
    });
    this.renderCandidates();
    this.refresh();
  },

  onClearPicked() {
    this._selectedIds = [];
    this.renderCandidates();
    this.refresh();
  },

  /* ---------------- 张数 ---------------- */
  onStep(e) {
    const { field, delta } = e.currentTarget.dataset;
    const next = Math.max(0, (this.data[field] || 0) + Number(delta));
    this.setData({ [field]: next });
    this.refresh();
  },

  onNumInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: Pricing.toSheets(e.detail.value) });   // 半张粒度，且不能用 parseInt
    this.refresh();
  },

  onDate(e) { this.setData({ date: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },

  /* ---------------- 保存（批量） ---------------- */
  onSave() { this.save(false); },
  onSaveClear() { this.save(true); },

  save(clearSelection) {
    if (!this._selectedIds.length) {
      return wx.showToast({ title: '请先选择学生', icon: 'none' });
    }
    try {
      // ★ 核心调用：一条语句同时给 N 个学生记账
      const res = store.addRecordsBatch(this._selectedIds, {
        sheets: this.data.sheets,
        date: this.data.date,
        time: U.toTimeString(Date.now()),
        note: this.data.note
      });

      wx.showToast({
        title: '已记录 ' + res.count + ' 人 · 合计 ' + U.money(res.totalAmountFen),
        icon: 'success'
      });

      if (clearSelection) this._selectedIds = [];
      this.setData({
        sheets: 0, note: '', search: '',
        lastBatchId: res.batchId,
        lastCount: res.count,
        lastTotalText: U.money(res.totalAmountFen)
      });
      this.refresh();
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    }
  },

  /* ---------------- 撤销上一批 ---------------- */
  onUndoBatch() {
    const info = store.getBatchInfo(this.data.lastBatchId);
    if (!info) return wx.showToast({ title: '这一批已不存在', icon: 'none' });
    wx.showModal({
      title: '撤销这一批',
      content: '将删除这一批（' + info.count + ' 人，合计 ' + U.money(info.totalAmountFen) + '）的全部记录',
      success: (r) => {
        if (!r.confirm) return;
        store.deleteBatch(this.data.lastBatchId);
        this.setData({ lastBatchId: '' });
        this.refresh();
        wx.showToast({ title: '已撤销', icon: 'success' });
      }
    });
  }
});
```

### 5.3 其它页面的最小写法

```js
// pages/records/records.js —— 只读列表，最简单
const store = getApp().store;
const U = require('../../core/utils.js');

Page({
  data: { list: [], summary: '', keyword: '', status: 'all' },
  onLoad() {
    this._unsub = store.subscribe(() => this.refresh());
    this.refresh();
  },
  onUnload() { if (this._unsub) this._unsub(); },
  onSearch(e) { this.setData({ keyword: e.detail.value }); this.refresh(); },
  onStatus(e) { this.setData({ status: e.currentTarget.dataset.key }); this.refresh(); },
  refresh() {
    const records = store.queryRecords({ keyword: this.data.keyword, status: this.data.status });
    const sum = store.summarize(records);
    // ★ 一定要在 JS 里把金额格式化成字符串
    this.setData({
      list: records.slice(0, 200).map(r => ({
        id: r.id,
        dateText: U.formatDateHuman(r.date),
        name: r.studentName,
        sheetsText: r.sheets + ' 张',
        amountText: U.money(r.amountFen),
        paidText: r.paymentId ? '已结清' : '未结清',
        paid: !!r.paymentId
      })),
      summary: '共 ' + sum.count + ' 条 · 合计 ' + U.money(sum.amountFen) + ' · 未结清 ' + U.money(sum.unpaidFen)
    });
  }
});
```

### 5.4 逗号批量勾选（这是最容易被迁移写错的一段）

搜索框输入 `zzh,zqy` 就自动勾上对应学生；**手动取消过的人不能被自动勾选覆盖**。
它不是一个简单的 filter，而是个小状态机，在页面实例上维护两个字段：

| 字段 | 作用 |
| --- | --- |
| `_autoMap` | `{ 词: [学生id] }`，每个词当前自动勾了谁；词被删掉/改短时按它把人退掉 |
| `_excluded` | 用户手动取消过谁的 id；自动勾选永远跳过这些人（搜索框清空时重置） |

```js
const SEP = /[,，;；、\/|\n]+/;   // 分隔符（故意不含空格：空格仍是"同一个人"的多条件）
const AUTO_MIN_LEN = 2;           // 至少 2 个字符才自动勾选，避免输一个字母就选一大片
const AUTO_MIN_SCORE = 66;        // 只要较靠谱的匹配（过滤掉"全拼中间片段"这类很松的命中）

Page({
  _selectedIds: [], _autoMap: {}, _excluded: [],

  splitTokens(text) {
    return String(text || '').split(SEP).map(t => t.trim()).filter(Boolean);
  },
  lastToken(text) {                       // 候选列表按"正在输入的最后一个词"过滤
    const parts = String(text || '').split(SEP);
    return (parts[parts.length - 1] || '').trim();
  },

  onSearchInput(e) {
    const text = e.detail.value;
    if (!text.trim()) {                   // 清空 = 这一轮结束
      this._autoMap = {}; this._excluded = [];
    } else {
      this.autoSelectByTokens(text);
    }
    this.renderCandidates();              // 内部用 this.lastToken(text)
    this.refresh();
  },

  autoSelectByTokens(text) {
    const store = getApp().store;
    const newMap = {};
    this.splitTokens(text).forEach(t => {
      if (t.length < AUTO_MIN_LEN) return;
      const ids = store.listStudents(t, AUTO_MIN_SCORE).map(s => s.id);  // 第 2 参数 = 分数门槛
      if (ids.length) newMap[t] = ids;
    });

    // ① 词被删掉/改短 → 它勾过的人退掉（除非还被别的词命中）
    const stillMatched = {};
    Object.values(newMap).forEach(ids => ids.forEach(id => { stillMatched[id] = true; }));
    Object.keys(this._autoMap).forEach(t => {
      if (newMap[t]) return;
      this._autoMap[t].forEach(id => {
        if (stillMatched[id]) return;
        const i = this._selectedIds.indexOf(id);
        if (i >= 0) this._selectedIds.splice(i, 1);
      });
    });

    // ② 勾选新匹配到的人（跳过用户手动取消过的）
    Object.keys(newMap).forEach(t => newMap[t].forEach(id => {
      if (this._excluded.indexOf(id) >= 0) return;
      if (this._selectedIds.indexOf(id) < 0) this._selectedIds.push(id);
    }));

    this._autoMap = newMap;
  },

  /** 手动点候选：取消的人进 _excluded，之后自动勾选不会再勾回来 */
  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const i = this._selectedIds.indexOf(id);
    if (i >= 0) {
      this._selectedIds.splice(i, 1);
      if (this._excluded.indexOf(id) < 0) this._excluded.push(id);
    } else {
      this._selectedIds.push(id);
      const j = this._excluded.indexOf(id);
      if (j >= 0) this._excluded.splice(j, 1);   // 手动勾回来 → 解除排除
    }
    this.renderCandidates();
    this.refresh();
  }
});
```

配套 WXML 的关键一行：

```xml
<input class="input" value="{{search}}" bindinput="onSearchInput" bindfocus="onFocus"
       placeholder="姓名 / 拼音首字母，用 , 分隔可批量选中（zzh,zqy）" />
```

> ⚠️ 别把它简化成「每次输入都重新全选一遍」——那样用户取消郑卓涵后，
> 一追加 `zjb` 郑卓涵又会被勾上来。`_excluded` 就是为这个场景存在的。

---

## 6. 各能力对照表

| 功能 | 网页版 | 小程序版 |
| --- | --- | --- |
| 存储 | `storage.createLocalStorageAdapter()` | `storage.createWxStorageAdapter(wx)` |
| 数据变化驱动界面 | `store.subscribe(render)` + `innerHTML` | `store.subscribe(() => this.setData(...))` |
| 页面切换 | `app.go(tab)` 手动切 tab | 原生 tabBar，无需处理 |
| 弹窗 | `ui/dom.js openModal` | `wx.showModal` / 自定义 view 弹层 |
| 轻提示 | `toast()` 自绘 | `wx.showToast` |
| 日期选择 | `<input type="date">` | `<picker mode="date">` |
| 数字步进 | `<input type="number">` | `<input type="digit">` + 按钮 |
| 导出 CSV | `Blob` + `<a download>` | 见第 7 节 |
| 导入 JSON | `<input type="file">` | `wx.chooseMessageFile` |
| 学生搜索下拉 | 绝对定位的 div | 绝对定位的 view（同样可行） |

**需要注意的小程序坑**

1. WXML 不能调用任意函数 → 金额、日期、状态文案**先在 JS 里格式化好**再 `setData`。
2. `setData` 是全量 diff，列表页面注意只传必要的字段（本项目已按此设计返回纯数据）。
3. `input` 的 `bindinput` 触发很频繁，`refresh()` 里避免做 O(n²) 计算（本项目统计都是 O(n)）。
4. 页面 `onUnload` 里记得取消 `subscribe`，否则会重复绑定（**和网页版的这个坑同源**：
   见 README「开发提示」，网页版是把事件挂在常驻容器上导致点一次弹 N 个弹窗；
   小程序里则是 `onLoad` 重复执行导致 `subscribe` 叠加，表现是「一次操作触发好几次」）。
5. 不要把页面事件绑到常驻的外层节点上。小程序的 `setData` 本身不会累积监听，
   但如果自己往 `wx.onXXX`、或者公共组件上重复注册回调，就会出现同类问题。
6. `wx.getStorageSync` 单 key 上限 1MB、总量 10MB。本系统一天几百条记录完全够用；
   若担心，可在「设置」页定期导出并把旧年份记录归档（`store.queryRecords({to:'2024-12-31'})` 后手动清理）。
7. 小程序里 `<input value="{{sheets}}">` 是**受控**的（`setData` 一改，输入框就变），
   所以不会出现网页版那个「点＋号输入框不变」的坑；但反过来要注意：
   用户正在输入时不要打断——`bindinput` 里只更新状态，不要立刻 `setData` 回同一个值。
8. **拼音搜索依赖运行环境的 ICU 中文排序**（`Intl.Collator`）。微信小程序在 Android(V8)/iOS(JSC)
   上通常都支持；万一不支持，`PrintSystem.Pinyin.mode` 会变成 `'plain'`，
   搜索自动降级为「原文匹配」，功能不会挂。上真机时可以先在 App 里跑一句
   `console.log(require('./core/pinyin.js').mode)` 确认一下。

---

## 7. 导出 CSV 在小程序里怎么做

小程序没有 `<a download>`，两种常见方案：

**方案 A（推荐，零成本）**：把 CSV 文本复制到剪贴板，让用户粘到微信/备忘录/文件传输助手

```js
wx.setClipboardData({
  data: store.exportRecordsCSV(null),   // 已带 BOM
  success: () => wx.showToast({ title: '已复制，粘贴到表格即可', icon: 'none' })
});
```

**方案 B**：写文件 + 转发给自己

```js
const fs = wx.getFileSystemManager();
const filePath = `${wx.env.USER_DATA_PATH}/打印记录_${U.todayString()}.csv`;
fs.writeFileSync(filePath, store.exportRecordsCSV(null), 'utf8');
wx.openDocument({ filePath, fileType: 'csv', showMenu: true });  // 右上角可转发
```

导入备份则用 `wx.chooseMessageFile({ type: 'file' })` 拿到临时路径后 `readFileSync(path,'utf8')`。

---

## 8. 升级到云开发（多人 / 多设备同步）

现在的存储是「整棵状态树存一个 key」。要多人共享，**不用改业务逻辑**，
只要写一个基于云数据库/云函数的适配器，并在 `subscribe` 里做同步：

```js
// core/storage-cloud.js（照着 core/storage.js 的接口写）
function createCloudAdapter(cloud) {
  let cache = null;
  return {
    name: 'cloud',
    getItem() { return cache; },                    // 首屏先用本地缓存渲染
    setItem(key, value) {
      cache = value;
      cloud.callFunction({ name: 'saveState', data: { key, value } })  // 异步上报
        .catch(err => console.error('同步失败', err));
    },
    removeItem() { cache = null; cloud.callFunction({ name: 'clearState' }); }
  };
}
```

配套建议：

- 云端存一份「整树 JSON」用于当天快速恢复，同时把 `records` **按条写入云数据库集合**，
  便于用云函数做真正的服务端统计与多端并发写入（`_id` 用记录自身的 `id`，天然幂等）。
- 多端同时记账时给每条记录加 `updatedAt`，用「后写覆盖 + 冲突提示」足够应付打印店场景。
- 金额字段继续保持「分」的整数，云端做聚合时不会出现浮点误差。

---

## 9. 迁移检查清单

- [ ] 复制 `js/core/` 到小程序项目，`require` 路径写对
- [ ] **复制 `js/vendor/`**（拼音库），否则搜索会降级成「只能原文匹配」
- [ ] `app.js` 换成 `createWxStorageAdapter(wx)`
- [ ] 从旧版本网页备份 JSON → 通过 `wx.chooseMessageFile` 导入（**一键搬数据**）
- [ ] 5 个 Page 的 `refresh()` 全部在 `onLoad` 里 `subscribe`、`onUnload` 里取消
- [ ] 所有金额/日期/状态在 JS 里格式化后再 `setData`
- [ ] 导出的 CSV 改成「复制到剪贴板」或「写文件转发」
- [ ] 真机测试：多选学生 → 批量保存 → 撤销这一批 → 结算 → 导出
- [ ] **搜索框逗号批量勾选**：输入 `zzh,zqy` 自动勾上 → 取消其中一个 → 追加 `,zjb`，被取消的不能被重新勾上
- [ ] **半张（0.5）**：快捷值 / 步进 / 手输都走 `Pricing.toSheets`，展示走 `U.qty`（别用 `parseInt`）
- [ ] 用 `store.exportJSON()` 备份一次，确认数据能完整恢复

> 迁移过程中**不要改 `core/`**。如果发现业务要变（比如加彩色价、按页计价），
> 改 `core/pricing.js` 一处即可，网页版和小程序版会同时生效。
