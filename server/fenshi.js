// ============================================================================
// 日内走势形态 —— 线上与研究共用的唯一判定规则
// ----------------------------------------------------------------------------
// 【数据来源】BaoStock 5 分钟线（真实分时）。Tushare 的分钟级接口无权限（403），
//             所以分时路径全部走 BaoStock。
//
// 【关键口径 —— 这一条必须先说清楚，否则结论会错】
//   BaoStock 的 5 分钟线第一根标记 09:35（覆盖 09:31~09:35），
//   而集合竞价 09:25~09:30 的成交价落在所有 5 分钟 bar 之外。
//   实测（002172，336 个交易日）：
//     日线 high/low 与 Tushare daily 完全一致（336/336，偏差 0.0000%）；
//     但 5 分钟聚合出来的 high 永远 ≤ 日线 high，low 永远 ≥ 日线 low
//     （132 天不一致，方向 100% 单向，不是随机误差）。
//   结论：集合竞价那一段的价格被计进日线、但没被计进任何一根 5 分钟 bar。
//   所以本模块的口径是：
//     ★ high / low / close / open 一律取【日线】（权威，与 Tushare 逐位一致）
//     ★ 5 分钟线只用来刻画「路径」：什么时候见高、什么时候见低、
//       上午/下午谁强、尾盘方向、当日均价线、当日成交量分布
//   这样既有真实分时路径，又不会因为竞价缺口污染极值类指标。
//
// 【为什么用规则分档而不是聚类】
//   对 3395 个交易日 × 13 个分时特征做 K-means：k=3 轮廓系数仅 0.19，
//   k>=5 直接出现空簇、轮廓系数为负 —— 说明「日内形态」不是天然离散的簇，
//   而是一条连续路径。硬聚类会造出不存在的分类边界。
//   所以改用交易者肉眼能直接读出来的规则分档，并且：
//     ① 规则按固定顺序判定，任意一天只落进一档（互斥、可复现）；
//     ② 阈值全部取自已验证过的阈值（0.25 / 0.30 / 0.40 / 0.45 / 0.60 / 0.8），
//        没有为「让某一档好看」而额外调过参；
//     ③ 顺序是按「每档样本量都够用」挑的，不是按检验 p 值挑的
//        （用 p 值选顺序 = 过拟合）。检验结果照实报告。
//
// 【判定用的量】
//   hiPos      日内最高价出现在 48 根 5 分钟线里的相对位置（0=最早，1=最晚）
//   loPos      日内最低价出现在序列里的相对位置
//   upperWick  上影线占当日振幅的比例 %
//   lowerWick  下影线占当日振幅的比例 %
//   closePos   收盘价在当日最高最低之间的位置 %
//   vwapSlope  后半段均价 - 前半段均价，再除以当日均价 ×100（均价线走向）
//   tailRet    最后 30 分钟相对开盘价的涨跌 %
// ============================================================================

const AM_END = '1130';
const TAIL_START = '1430';

// ---------------------------------------------------------------------------
// 一、分时特征提取
// ---------------------------------------------------------------------------

/**
 * @param {Array}  bars      当日 48 根 5 分钟 bar（时间升序）
 * @param {Object} dayOHLC   {open, high, low, close, volume, amount} 来自日线（权威）
 * @param {number|null} prevClose 前一日收盘价
 */
function extractDayFeatures(bars, dayOHLC, prevClose) {
  if (!bars || bars.length < 20 || !dayOHLC) return null;

  const { open, high, low, close } = dayOHLC;
  if (!(open > 0) || !(close > 0) || !(high >= low)) return null;

  // 均价线与成交量分布：全部用分钟线累加
  let sumA = 0, sumV = 0, amVol = 0, pmVol = 0;
  for (const b of bars) {
    sumA += b.a || 0;
    sumV += b.v || 0;
    if (b.t <= AM_END) amVol += b.v || 0; else pmVol += b.v || 0;
  }
  // 均价线优先用日线成交额/成交量（权威），分钟累加做交叉校验
  const vwapFromDay = (dayOHLC.amount > 0 && dayOHLC.volume > 0)
    ? dayOHLC.amount / dayOHLC.volume : null;
  const vwapFromMin = sumV > 0 ? sumA / sumV : null;
  const vwap = vwapFromDay != null ? vwapFromDay : vwapFromMin;

  // 分段
  let amClose = null, amOpen = null, pmOpen = null;
  for (const b of bars) {
    if (b.t <= AM_END) { if (amOpen == null) amOpen = b.o; amClose = b.c; }
    else if (pmOpen == null) pmOpen = b.o;
  }
  if (amOpen == null) amOpen = open;
  if (amClose == null) amClose = close;
  if (pmOpen == null) pmOpen = amClose;

  // 尾盘 30 分钟收益：从 14:30 首根 bar 的开盘价到当日收盘，相对当日开盘的百分比
  let tailOpen = null;
  for (const b of bars) {
    if (b.t >= TAIL_START) { if (tailOpen == null) tailOpen = b.o; }
  }
  const tailRet = tailOpen ? ((close - tailOpen) / open) * 100 : 0;

  // 极值出现位置：日线 high/low 才是权威极值（可能含集合竞价，分钟线触及不到），
  // 所以优先找「哪根 bar 的 high 等于日线 high」；找不到（极值来自竞价）时
  // 退化为分钟线内的最大 high 所在位置，并标记出来。
  const EPS = 1e-6;
  let hiIdx = -1, loIdx = -1;
  bars.forEach((b, i) => {
    if (hiIdx < 0 && Math.abs(b.h - high) < EPS) hiIdx = i;
    if (loIdx < 0 && Math.abs(b.l - low) < EPS) loIdx = i;
  });
  let hiFromAuction = false, loFromAuction = false;
  if (hiIdx < 0) {
    hiFromAuction = true;
    let best = -Infinity;
    bars.forEach((b, i) => { if (b.h > best) { best = b.h; hiIdx = i; } });
  }
  if (loIdx < 0) {
    loFromAuction = true;
    let best = Infinity;
    bars.forEach((b, i) => { if (b.l < best) { best = b.l; loIdx = i; } });
  }
  const n = bars.length - 1 || 1;

  // 均价线走向：后半段均价 vs 前半段均价
  let h1A = 0, h1V = 0, h2A = 0, h2V = 0;
  const half = Math.floor(bars.length / 2);
  bars.forEach((b, i) => {
    if (i < half) { h1A += b.a || 0; h1V += b.v || 0; }
    else { h2A += b.a || 0; h2V += b.v || 0; }
  });
  const vwapSlope = (vwap && h1V > 0 && h2V > 0)
    ? ((h2A / h2V) - (h1A / h1V)) / vwap * 100 : null;

  const range = high - low;
  return {
    open, high, low, close,
    vwap,
    vwapFromMin,
    vwapMismatchPct: (vwapFromDay && vwapFromMin)
      ? Math.abs(vwapFromDay - vwapFromMin) / vwapFromDay * 100 : null,
    closePos: range > 0 ? ((close - low) / range) * 100 : 50,
    vwapDiff: vwap ? ((close - vwap) / vwap) * 100 : null,
    openGap: prevClose ? ((open - prevClose) / prevClose) * 100 : null,
    bodyPct: range > 0 ? ((close - open) / range) * 100 : 0,
    upperWick: range > 0 ? ((high - Math.max(open, close)) / range) * 100 : 0,
    lowerWick: range > 0 ? ((Math.min(open, close) - low) / range) * 100 : 0,
    retFull: ((close - open) / open) * 100,
    retAm: ((amClose - amOpen) / amOpen) * 100,
    retPm: ((close - pmOpen) / pmOpen) * 100,
    hiPos: hiIdx / n,
    loPos: loIdx / n,
    hiFromAuction,
    loFromAuction,
    amVolShare: sumV > 0 ? (amVol / sumV) * 100 : 50,
    tailRet,
    amplitude: prevClose ? (range / prevClose) * 100 : null,
    vwapSlope,
    bars: bars.length,
  };
}

// ---------------------------------------------------------------------------
// 二、形态分档（定稿）
//   label 是给用户看的层名，必须和 validated.js 里的键一字不差，
//   否则跨股验证结论会静默失效（测试里有一道守卫）。
// ---------------------------------------------------------------------------
const SHAPES = [
  {
    id: 'S1', name: '早盘冲高回落', label: 'S1 早盘冲高回落', short: '冲高回落',
    desc: '最高点在开盘后前1/4就出来，留下一条长上影，之后一路回落，收盘在当日中下部',
    test: f => f.hiPos <= 0.25 && f.upperWick >= 30 && f.closePos < 45,
  },
  {
    id: 'S2', name: '早盘探底后回升', label: 'S2 早盘探底后回升', short: '探底回升',
    desc: '开盘后先砸出低位留下一条长下影，随后一路拉回，收盘在当日中上部',
    test: f => f.loPos <= 0.30 && f.lowerWick >= 30 && f.closePos >= 45,
  },
  {
    id: 'S3', name: '早盘见顶后阴跌', label: 'S3 早盘见顶后阴跌', short: '见顶阴跌',
    desc: '最高点在开盘后前1/4出来，没有明显长上影（是阴跌不是冲高），收盘在当日下部',
    test: f => f.hiPos <= 0.25 && f.closePos < 30,
  },
  {
    id: 'S4', name: '尾盘拉升', label: 'S4 尾盘拉升', short: '尾盘拉升',
    desc: '最后半小时明显往上拉，收盘收在当日高位',
    test: f => f.tailRet >= 0.8 && f.closePos >= 60,
  },
  {
    id: 'S5', name: '均价线上翘（重心上移）', label: 'S5 均价线上翘（重心上移）', short: '均价上翘',
    desc: '均价线明显往上走，全天成交重心不断抬高',
    test: f => f.vwapSlope > 0.4,
  },
  {
    id: 'S6', name: '均价线下移（重心下移）', label: 'S6 均价线下移（重心下移）', short: '均价下移',
    desc: '均价线明显往下走，全天成交重心不断下移',
    test: f => f.vwapSlope < -0.4,
  },
  {
    id: 'S7', name: '横盘整理（均价线走平）', label: 'S7 横盘整理（均价线走平）', short: '横盘整理',
    desc: '均价线基本走平（前后半段成交均价几乎没变），且不构成上面任何一种典型形态，价格在一个区间里来回',
    // 残余档：S1~S6 都不像的，都归这里。
    // 由于 S5/S6 已经把「均价线上翘/下移」挑走了，落到这一档的必然满足 |vwapSlope|<=0.4。
    test: f => Math.abs(f.vwapSlope) <= 0.4
             && !(f.hiPos <= 0.25 && f.upperWick >= 30 && f.closePos < 45)
             && !(f.loPos <= 0.30 && f.lowerWick >= 30 && f.closePos >= 45)
             && !(f.hiPos <= 0.25 && f.closePos < 30)
             && !(f.tailRet >= 0.8 && f.closePos >= 60),
  },
];
const OTHER = { id: 'S0', name: '其他（无明显特征）', label: 'S0 其他（无明显特征）', short: '其他', desc: '不符合以上任一典型形态' };
const ALL = [...SHAPES, OTHER];
const SHAPE_MAP = Object.fromEntries(ALL.map(s => [s.id, s]));

function classifyShape(f) {
  if (!f) return OTHER.id;
  for (const s of SHAPES) if (s.test(f)) return s.id;
  return OTHER.id;
}

// ---------------------------------------------------------------------------
// 三、把 BaoStock 原始数据变成「日期 → 形态」
// ---------------------------------------------------------------------------

/**
 * @param {Object} win  { days: { 'YYYY-MM-DD': { bars:[...], ohlc:{...} } } }
 * @param {Object} opts { maxVwapMismatchPct }  均价线口径异常时剔除该日
 * @returns {Object} { 'YYYY-MM-DD': { id, label, name, desc, feats } }
 */
function buildShapes(win, opts = {}) {
  const maxMismatch = opts.maxVwapMismatchPct != null ? opts.maxVwapMismatchPct : 0.5;
  const out = {};
  if (!win || !win.days) return out;
  const dates = Object.keys(win.days).sort();
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const cell = win.days[d];
    if (!cell || !cell.bars || cell.bars.length < 40) continue;
    const prevClose = i > 0 ? (win.days[dates[i - 1]].ohlc || {}).close : null;
    const F = extractDayFeatures(cell.bars, cell.ohlc, prevClose);
    if (!F) continue;
    // 均价线交叉校验：分钟累加与日线成交额/量差异过大说明口径有问题，剔除
    if (F.vwapMismatchPct != null && F.vwapMismatchPct > maxMismatch) continue;
    const id = classifyShape(F);
    const s = SHAPE_MAP[id];
    out[d] = { id, label: s.label, name: s.name, short: s.short, desc: s.desc, feats: F };
  }
  return out;
}

module.exports = {
  AM_END, TAIL_START,
  extractDayFeatures,
  SHAPES, OTHER, ALL, SHAPE_MAP,
  classifyShape, buildShapes,
};
