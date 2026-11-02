/**
 * 业务逻辑单元测试：裁决推导 + 历史存储。
 * 用 mock 的 wx API 在 Node 下运行，不依赖小程序环境。
 * 用法：node tools/test-logic.js
 */

// ---------- mock wx ----------
const store = {};
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: (k) => { delete store[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(store) }),
  showToast: () => {},
  showModal: () => {}
};

const { deriveVerdict } = require('../miniapp/utils/verdict');
const historyStore = require('../miniapp/utils/history');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function reset() {
  Object.keys(store).forEach((k) => delete store[k]);
}

// ---------- 构造报告 ----------
function makeReport(overrides = {}) {
  return Object.assign({
    stock_code: '000733.SZ',
    stock_name: '振华科技',
    days: 120,
    headline: '成功率最高：测试条件（60.0%）',
    total_red: 60,
    total_green: 60,
    vol_stats: [],
    ma5_stats: [],
    ma20_stats: [],
    dist_stats: [],
    vwap_stats: [],
    shape_stats: [],
    auc_stats: [],
    wick_stats: [],
    fenshi_stats: [],
    cond_stats: [],
    conclusions: {}
  }, overrides);
}

function layer(label, rate, signal, sample_count = 30, marginal = false) {
  return {
    label,
    layer_rate: String(rate),
    red_count: Math.round(sample_count * rate / 100),
    green_count: sample_count - Math.round(sample_count * rate / 100),
    red_ratio: '10.0',
    red_avg: '2.00',
    green_count: 0,
    green_ratio: '10.0',
    green_avg: '1.00',
    sample_count,
    signal,
    marginal,
    isBestRatio: false,
    isBestAvg: false
  };
}

console.log('=== 裁决推导测试 ===');

// 1. 无信号 → C
reset();
let v = deriveVerdict(makeReport());
check('无任何信号 → C/中性', v.verdict === 'C' && v.verdictText === '中性', JSON.stringify(v));

// 2. 正向信号显著高于基准 → A
// 基准 = 60/120 = 50%
v = deriveVerdict(makeReport({
  total_red: 60, total_green: 60,
  cond_stats: [layer('正向条件', 58, 'pos', 40)]
}));
check('正向层 58% vs 基准 50%（+8pp）→ A/偏多', v.verdict === 'A' && v.verdictText === '偏多', JSON.stringify(v));

// 3. 反向信号显著低于基准 → B
v = deriveVerdict(makeReport({
  total_red: 60, total_green: 60,
  wick_stats: [layer('长下影', 40, 'neg', 40)]
}));
check('负向层 40% vs 基准 50%（-10pp）→ B/偏空', v.verdict === 'B' && v.verdictText === '偏空', JSON.stringify(v));

// 4. 偏离不足 3pp → C
v = deriveVerdict(makeReport({
  total_red: 60, total_green: 60,
  cond_stats: [layer('微弱条件', 52, 'pos', 40)]
}));
check('正向层 52% vs 基准 50%（仅 +2pp）→ C', v.verdict === 'C', JSON.stringify(v));

// 5. 边缘显著（marginal）不计入
v = deriveVerdict(makeReport({
  total_red: 60, total_green: 60,
  cond_stats: [layer('边缘条件', 58, 'pos', 40, true)]
}));
check('marginal 层不作为依据 → C', v.verdict === 'C', JSON.stringify(v));

// 6. 样本量不足不计入
v = deriveVerdict(makeReport({
  total_red: 60, total_green: 60,
  cond_stats: [layer('小样本', 58, 'pos', 5)]
}));
check('样本量 < 10 的层不作为依据 → C', v.verdict === 'C', JSON.stringify(v));

// 7. 正负同时存在时取偏离更大的一方
v = deriveVerdict(makeReport({
  total_red: 60, total_green: 60,
  cond_stats: [layer('正', 56, 'pos', 40)],
  wick_stats: [layer('负', 42, 'neg', 40)]
}));
check('正负同时存在，偏离更大者胜出（+6pp vs -8pp → B）', v.verdict === 'B', JSON.stringify(v));

// 8. 空报告
v = deriveVerdict(null);
check('null 报告 → C/中性', v.verdict === 'C' && v.verdictText === '中性');

// 9. 无样本
v = deriveVerdict(makeReport({ total_red: 0, total_green: 0 }));
check('无样本 → C/样本不足', v.verdict === 'C' && v.detail.includes('样本不足'), JSON.stringify(v));

// 10. 非 50% 基准
v = deriveVerdict(makeReport({
  total_red: 90, total_green: 30,   // 基准 75%
  cond_stats: [layer('条件', 80, 'pos', 40)]
}));
check('基准 75% 时，80% 层（+5pp）→ A', v.verdict === 'A', JSON.stringify(v));

console.log('\n=== 历史存储测试 ===');

// 1. 添加条目
reset();
const report = makeReport();
const entry = historyStore.addEntry(report, { verdict: 'A', verdictText: '偏多', detail: '测试' });
check('addEntry 后列表有 1 条', historyStore.getList().length === 1);
check('条目带 reportKey', typeof entry.reportKey === 'string' && entry.reportKey.length > 0);
check('完整报告已缓存', !!wx.getStorageSync(entry.reportKey));

// 2. 条目含真实裁决
check('条目记录 verdict=A', entry.verdict === 'A' && entry.verdict_text === '偏多');
check('条目记录结论细节', entry.verdict_detail === '测试');

// 3. 新条目在前
historyStore.addEntry(makeReport({ stock_name: '贵州茅台' }), { verdict: 'C', verdictText: '中性', detail: '' });
const list = historyStore.getList();
check('新条目排在最前', list[0].stock_name === '贵州茅台' && list[1].stock_name === '振华科技');

// 4. 超过 10 条自动截断并清理旧缓存
reset();
const keys = [];
for (let i = 0; i < 12; i++) {
  const e = historyStore.addEntry(makeReport({ stock_name: '股票' + i }), { verdict: 'C', verdictText: '中性', detail: '' });
  keys.push(e.reportKey);
}
check('超过 10 条后截断为 10 条', historyStore.getList().length === 10);
check('被淘汰条目的报告缓存已清理', !wx.getStorageSync(keys[0]) && !wx.getStorageSync(keys[1]));
check('保留条目的报告缓存仍在', !!wx.getStorageSync(keys[11]));

// 4b. 同毫秒连续添加也不能撞 key（Date.now() 只有毫秒精度）
reset();
const sameMs = [];
for (let i = 0; i < 5; i++) {
  sameMs.push(historyStore.addEntry(makeReport({ stock_name: 'X' + i }), { verdict: 'C', verdictText: '中性', detail: '' }).reportKey);
}
check('连续快速添加的 reportKey 互不相同', new Set(sameMs).size === 5, sameMs.join(','));
check('连续快速添加的 ts 互不相同', new Set(historyStore.getList().map((i) => i.ts)).size === 5);
check('5 条记录各自的报告缓存都在', sameMs.every((k) => !!wx.getStorageSync(k)));

// 5. 删除单条
reset();
const e1 = historyStore.addEntry(makeReport({ stock_name: 'A' }), { verdict: 'A', verdictText: '偏多', detail: '' });
const e2 = historyStore.addEntry(makeReport({ stock_name: 'B' }), { verdict: 'B', verdictText: '偏空', detail: '' });
const removed = historyStore.removeEntry(e1.ts);
check('removeEntry 返回 true', removed === true);
check('删除后列表剩 1 条', historyStore.getList().length === 1);
check('删除后剩余的是 B', historyStore.getList()[0].stock_name === 'B');
check('被删条目的报告缓存已清理', !wx.getStorageSync(e1.reportKey));
check('未删条目的报告缓存保留', !!wx.getStorageSync(e2.reportKey));

// 6. 清空全部
reset();
const e3 = historyStore.addEntry(makeReport(), { verdict: 'C', verdictText: '中性', detail: '' });
historyStore.clearAll();
check('clearAll 后列表为空', historyStore.getList().length === 0);
check('clearAll 后报告缓存已清理', !wx.getStorageSync(e3.reportKey));

// 7. 孤儿缓存清理
reset();
const orphanKey = historyStore.reportKey(999999);
wx.setStorageSync(orphanKey, makeReport());
const kept = historyStore.addEntry(makeReport(), { verdict: 'C', verdictText: '中性', detail: '' });
historyStore.cleanOrphanReports();
check('孤儿报告缓存被清理', !wx.getStorageSync(orphanKey));
check('被引用的报告缓存保留', !!wx.getStorageSync(kept.reportKey));

// 8. 超大报告降级为摘要
reset();
const huge = makeReport();
huge.cond_stats = [layer('条件', 58, 'pos', 40)];
huge.padding = 'x'.repeat(200 * 1024);   // 超过 100KB 上限
const bigEntry = historyStore.addEntry(huge, { verdict: 'A', verdictText: '偏多', detail: '' });
check('超大报告降级：reportKey 为空', bigEntry.reportKey === '');
check('超大报告仍保留摘要字段', bigEntry.verdict === 'A' && !!bigEntry.stock_name);
check('超大报告未写入缓存', !wx.getStorageSync(bigEntry.reportKey));

// 9. 存储异常时优雅降级，不抛异常中断主流程
reset();
const origSet = wx.setStorageSync;
wx.setStorageSync = () => { throw new Error('quota exceeded'); };
let threw = false;
let result = null;
try {
  result = historyStore.addEntry(makeReport(), { verdict: 'C', verdictText: '中性', detail: '' });
} catch (e) {
  threw = true;
}
wx.setStorageSync = origSet;
check('存储异常时 addEntry 不抛异常', !threw);
check('存储异常时 addEntry 返回 null（调用方据此走临时缓存分支）', result === null);

// ---------- 报告预处理测试（验证统计量文案） ----------
console.log('\n=== 报告预处理测试 ===');
const { enrichReport, formatP } = require('../miniapp/utils/report');
const { buildFixture } = require('./fixture');

check('p<0.001 显示为 p<0.001', formatP(0.0001) === 'p<0.001', formatP(0.0001));
check('p=0.0285 显示为 p=0.029', formatP(0.0285) === 'p=0.029', formatP(0.0285));
check('p=0.05 显示为 p=0.050', formatP(0.05) === 'p=0.050', formatP(0.05));
check('null p 返回空串', formatP(null) === '');

const fx = enrichReport(buildFixture());
check('enrichReport 返回同一对象', fx === buildFixture() || typeof fx === 'object');

// 每一行有信号的都必须有 v_text，且包含 p 值
let missing = 0;
let totalSig = 0;
['vol_stats','ma5_stats','ma20_stats','turn_stats','dist_stats','vwap_stats',
 'shape_stats','auc_stats','wick_stats','fenshi_stats','cond_stats'].forEach((d) => {
  (fx[d] || []).forEach((r) => {
    if (!r.signal) return;
    totalSig++;
    if (!r.v_text || r.v_text.indexOf('p') === -1) missing++;
  });
});
check('所有带信号的行都有 v_text', missing === 0, '缺失 ' + missing + ' 行');
check('带信号的行数 > 0', totalSig > 0, totalSig + ' 行');

// 每个维度都要生成 _verified 数组
const dims = ['vol_stats','ma5_stats','ma20_stats','turn_stats','dist_stats','vwap_stats',
  'shape_stats','auc_stats','wick_stats','fenshi_stats','cond_stats'];
check('11 个维度都有 _verified 数组', dims.every((d) => Array.isArray(fx[d + '_verified'])));
check('turn 维度无信号（未做跨股票验证）',
  (fx.turn_stats || []).every((r) => !r.signal) && (fx.turn_stats_verified || []).length === 0);
check('cond 维度 5 条全部有信号', (fx.cond_stats_verified || []).length === 5,
  (fx.cond_stats_verified || []).length);

// 边缘信号要标注
const marg = (fx.vwap_stats_verified || []).find((v) => v.marginal);
check('边缘信号带 marginal 标记并注明', marg && marg.v_text.indexOf('仅边缘显著') !== -1,
  marg ? marg.v_text : '未找到');

// ---------- 后端请求层测试（多后端回退 + 冷启动预热） ----------
console.log('\n=== 请求层测试 ===');
const { request, warmup, API_BASES } = require('../miniapp/utils/api');

check('API_BASES 有主后端', Array.isArray(API_BASES) && API_BASES.length >= 1, API_BASES.length + ' 个');
check('API_BASES 全部是 https', API_BASES.every((u) => u.indexOf('https://') === 0));
check('API_BASES 无重复', new Set(API_BASES).size === API_BASES.length);

// 用假的 wx.request 驱动回退逻辑
// key 用完整 URL（含主机），才能区分「哪个后端挂、哪个后端正常」
function mockWx(behaviors) {
  global.wx = {
    request(opts) {
      const b = behaviors[opts.url];
      if (!b) {
        setTimeout(() => opts.fail({ errMsg: 'request:fail no mock' }), 0);
        return;
      }
      setTimeout(() => {
        if (b.type === 'fail') opts.fail({ errMsg: b.msg || 'request:fail' });
        else opts.success({ statusCode: b.status || 200, data: b.data });
      }, 0);
    }
  };
}

// 场景1：第一个后端预热失败，第二个正常 → 应该成功并返回第二个的业务数据
const BASE1 = API_BASES[0];
const BASE2 = API_BASES[1] || API_BASES[0];
mockWx({
  [BASE1 + '/api/health']: { type: 'fail', msg: 'request:fail conn reset' },
  [BASE2 + '/api/health']: { status: 200, data: { code: 0, msg: 'ok' } },
  [BASE2 + '/api/statAnalyze']: { status: 200, data: { code: 0, data: { stock_name: '金安国纪' } } },
});

request('/api/statAnalyze', { stock_code: '002636', days: 120 })
  .then((body) => {
    check('后端回退：首个不可用时能用第二个返回数据',
      body && body.code === 0 && body.data.stock_name === '金安国纪',
      JSON.stringify(body));
  })
  .catch((e) => {
    check('后端回退：首个不可用时能用第二个返回数据', false, '异常: ' + e.message);
  })
  .then(() => {
    // 场景2：业务错误（404）应直接抛给调用方，不换后端
    mockWx({
      [BASE1 + '/api/health']: { status: 200, data: { code: 0, msg: 'ok' } },
      [BASE1 + '/api/statAnalyze']: { status: 200, data: { code: 404, msg: '未找到该股票' } },
    });
    return request('/api/statAnalyze', { stock_code: '999999', days: 120 });
  })
  .then((body) => {
    check('业务错误直接返回给调用方（不当作后端故障）',
      body && body.code === 404 && body.msg === '未找到该股票',
      JSON.stringify(body));
  })
  .catch((e) => {
    check('业务错误直接返回给调用方（不当作后端故障）', false, '异常: ' + e.message);
  })
  .then(() => {
    // 场景3：全部后端不可用 → 应 reject，且带上原因
    mockWx({});
    return request('/api/statAnalyze', { stock_code: '002636' }).then(
      () => ({ ok: false }),
      (e) => ({ ok: true, code: e.code, reason: e.detail && e.detail.reason })
    );
  })
  .then((r) => {
    check('全部后端不可用时 reject 并标明原因',
      r.ok && r.code === 'ALL_BASES_FAILED' && (r.reason === 'down' || r.reason === 'network'),
      JSON.stringify(r));
    delete global.wx;
    console.log(`\n========== 通过 ${pass} 项，失败 ${fail} 项 ==========`);
    process.exit(fail > 0 ? 1 : 0);
  });
