// ============================================================================
// 跨股票验证结论表（唯一事实来源）
// ----------------------------------------------------------------------------
// 背景：单只股票 120 个样本很容易把纯噪声层选成「冠军」。例如澳洋健康的
// 「前一天跌超5%」在它自己历史上红盘率 60%，看起来很棒，但跨 10 只股票
// 检验后 p=0.98 —— 完全是噪声。所以「成功率最高 / 涨幅最高」这两个标签
// 不能只看单股，必须先过跨股票验证这一关。
//
// 数据来源：10 只股票 × 3335 个样本（20250603~20261026）
// 检验方法：
//   1) 层内红盘率 vs 该层以外样本 的两比例 z 检验（p 值）
//   2) 股票级 bootstrap 2000 次重采样（重采样单元 = 股票）
//   3) 按时间对半切分（前半 / 后半红盘率）
//   4) 四个自然季度分别统计
//   5) 逐股方向一致性：该层在几只股票上高于/低于该股自身基准
// 只有 p < 0.05 且方向一致性 ≥ 7/10 且 bootstrap 稳定 的层，才允许被评选。
// ============================================================================

// ---------------------------------------------------------------------------
// 表一：成功率（层内红盘率）验证结论
//   dir: 'pos' = 正向信号（该层次日更容易红）
//        'neg' = 反向信号（该层次日更容易绿）
//   p   : 两比例 z 检验的 p 值
//   z   : z 值
//   stocks : 10 只股票里方向一致的数量
//   marginal : true 表示 p 在 0.05~0.10 之间，只是「边缘」显著（方向一致但检验没过 0.05）。
//              这类层只作参考提示，不能当结论用，UI 上会标成「⚠边缘」。
// 未列出的层 = 没有通过跨股票验证，一律不得参与「成功率最高」评选。
// ---------------------------------------------------------------------------
const CROSS_VALIDATED_RATE = {
  // ① 量比分层：只有「缩量」通过
  vol: {
    '缩量(<0.7)': { dir: 'pos', p: 0.0285, z: 2.191, stocks: 8 },
  },

  // ② 收盘 vs 5日线：四层全部未通过（最好的 p=0.0758）→ 本维度没有成功率信号
  ma5: {},

  // ③ 收盘 vs 20日线：四层全部不显著（p 0.30~0.98）→ 本维度没有成功率信号
  ma20: {},

  // ④ 前日涨跌幅分布：只有「前一天涨 1~3%」是稳定的反向信号
  dist: {
    '1~3%': { dir: 'neg', p: 0.0101, z: -2.571, stocks: 7 },
  },

  // ⑤ 综合条件：以下 5 条通过跨股票验证
  cond: {
    '收盘价跌破当日均价线 + 缩量 + 股价在5日线下方': { dir: 'pos', p: 0.0004, z: 3.550, stocks: 8 },
    '收盘价跌破当日均价线 + 缩量': { dir: 'pos', p: 0.0003, z: 3.617, stocks: 8 },
    '收盘价跌破当日均价线 + 股价在5日线下方': { dir: 'pos', p: 0.0030, z: 2.965, stocks: 9 },
    '集合竞价温和放量（1.2~2.5倍） + 当日缩量': { dir: 'pos', p: 0.0001, z: 3.972, stocks: 8 },
    '收盘价跌破均价线 + 收在日内最低位 + 缩量': { dir: 'pos', p: 0.0001, z: 4.003, stocks: 9 },
  },

  // ⑥ 收盘 vs 当日均价线
  vwap: {
    '收盘价低于当日均价线0.5%以上': { dir: 'pos', p: 0.0051, z: 2.802, stocks: 9 },
    '收盘价高于当日均价线0.5%以上': { dir: 'neg', p: 0.0555, z: -1.915, stocks: 8, marginal: true },
  },

  // ⑦ 日内形态（收盘位置 × 均价线交叉）
  shape: {
    'A 弱势收盘（收在日内最低位且破均价线）': { dir: 'pos', p: 0.0015, z: 3.171, stocks: 9 },
    'D 强势收盘（收在日内最高位且站上均价线）': { dir: 'neg', p: 0.0804, z: -1.748, stocks: 9, marginal: true },
  },

  // ⑧ 集合竞价（4 档）
  auc: {
    '竞价温和放量（1.2~2.5倍）': { dir: 'pos', p: 0.0007, z: 3.390, stocks: 8 },
    '竞价缩量（<近5日竞价均量0.8倍）': { dir: 'neg', p: 0.0374, z: -2.082, stocks: 7 },
  },

  // ⑨ 长下影（盘中杀跌后拉回）：稳定的反向信号
  wick: {
    '盘中杀跌后拉回（下影线>1.5%）': { dir: 'neg', p: 0.0020, z: -3.083, stocks: 8 },
  },

  // 换手率分层未做跨股票验证（口径不可跨股票比较），不参与评选
  turn: {},
};

// ---------------------------------------------------------------------------
// 表二：涨幅（红盘均涨）验证结论
//   判据：该层的「红盘均涨」在 10 只股票里有 ≥7 只高于该股自身基准，
//         且该层样本数 ≥ 20。只有这样的层才允许被评「涨幅最高」。
//   stocks : 方向（红盘均涨高于该股基准）一致的股票数
//   redAvg : 全样本红盘均涨（%）
// ---------------------------------------------------------------------------
const CROSS_VALIDATED_AVG = {
  vol: {
    '放量(1.2-2.0)': { stocks: 8, redAvg: 2.25 },
  },
  ma5: {
    '股价在5日线上方（偏离>5%）': { stocks: 7, redAvg: 5.00 },
  },
  ma20: {
    '股价在20日线上方（偏离>10%）': { stocks: 7, redAvg: 4.42 },
    '股价在20日线上方（0~10%）': { stocks: 7, redAvg: 2.07 },
  },
  dist: {
    '>5%': { stocks: 7, redAvg: 4.93 },
  },
  vwap: {
    '收盘价低于当日均价线0.5%以上': { stocks: 8, redAvg: 2.39 },
  },
  shape: {
    'B 破均价线但未收在最低位': { stocks: 7, redAvg: 2.49 },
  },
  auc: {
    '竞价过度放量（≥2.5倍）': { stocks: 7, redAvg: 2.83 },
  },
  wick: {
    '盘中杀跌后拉回（下影线>1.5%）': { stocks: 8, redAvg: 3.20 },
  },
  cond: {
    '收盘价跌破当日均价线 + 股价在5日线下方': { stocks: 7, redAvg: 2.28 },
    '盘中杀跌后拉回（下影线>1.5%，次日偏弱）': { stocks: 8, redAvg: 3.20 },
  },
  turn: {},
};

// 某维度下允许参与「成功率最高」评选的正向层标签
function rateEligibleLabels(dim) {
  const map = CROSS_VALIDATED_RATE[dim] || {};
  return new Set(Object.keys(map).filter(k => map[k].dir === 'pos'));
}

// 某维度下允许参与「涨幅最高」评选的层标签
function avgEligibleLabels(dim) {
  return new Set(Object.keys(CROSS_VALIDATED_AVG[dim] || {}));
}

// 某维度下通过验证的反向信号层（次日更容易绿）——这类层不能拿「成功率最高」，
// 但要在结论里点出来，否则用户会以为「该维度没信号」，实际是「信号方向朝下」。
// marginal（p 在 0.05~0.10 之间、只是边缘显著）单独一套，UI 上标「⚠边缘」。
function negativeLabels(dim) {
  const map = CROSS_VALIDATED_RATE[dim] || {};
  return new Set(Object.keys(map).filter(k => map[k].dir === 'neg' && !map[k].marginal));
}

function marginalNegativeLabels(dim) {
  const map = CROSS_VALIDATED_RATE[dim] || {};
  return new Set(Object.keys(map).filter(k => map[k].dir === 'neg' && map[k].marginal));
}

// 该层是否只是边缘显著
function isMarginal(dim, label) {
  const map = CROSS_VALIDATED_RATE[dim] || {};
  return !!(map[label] && map[label].marginal);
}

// 某层的信号方向：'pos' | 'neg' | null（未验证）
function signalOf(dim, label) {
  const map = CROSS_VALIDATED_RATE[dim] || {};
  return map[label] ? map[label].dir : null;
}

// 该维度是否存在任何通过验证的正向信号
function hasPositiveRate(dim) {
  return rateEligibleLabels(dim).size > 0;
}

module.exports = {
  CROSS_VALIDATED_RATE,
  CROSS_VALIDATED_AVG,
  rateEligibleLabels,
  avgEligibleLabels,
  negativeLabels,
  marginalNegativeLabels,
  isMarginal,
  signalOf,
  hasPositiveRate,
};
