/**
 * 从 statAnalyze 报告推导 A/B/C 裁决。
 *
 * statAnalyze 接口本身不返回裁决字段（原 backtest 接口的 A/B/C 语义是
 * 「追涨 / 低吸 / 不适合做T+1」，和现在的次日红绿盘统计不是一回事，
 * 直接复用会误导用户），所以这里基于报告里的真实分层数据重新推导：
 *
 *   A = 偏多：存在通过跨股票验证的正向层，层内红盘率明显高于基准
 *   B = 偏空：存在验证过的看空层，层内红盘率明显低于基准
 *   C = 中性：各维度都没有明显偏离基准的验证信号
 *
 * 基准红盘率 = total_red / (total_red + total_green)，即这只股票本身
 * 「平均每 100 天有多少天次日收红」。
 */

const STAT_DIMENSIONS = [
  'vol_stats', 'ma5_stats', 'ma20_stats', 'dist_stats',
  'vwap_stats', 'shape_stats', 'auc_stats', 'wick_stats',
  'fenshi_stats', 'cond_stats'
];

// 层内红盘率相对基准至少要高出这么多个百分点，才认为信号有意义
const EDGE_THRESHOLD = 3;
// 层内样本量下限，低于此值一律当噪声丢弃（120 天样本很容易选出假冠军）
const MIN_SAMPLE = 10;

function deriveVerdict(report) {
  if (!report) {
    return { verdict: 'C', verdictText: '中性', detail: '暂无数据' };
  }

  const red = Number(report.total_red) || 0;
  const green = Number(report.total_green) || 0;
  const total = red + green;
  if (!total) {
    return { verdict: 'C', verdictText: '中性', detail: '样本不足，无法判定' };
  }

  const base = (red / total) * 100;
  let posEdge = 0;
  let posLabel = '';
  let negEdge = 0;
  let negLabel = '';

  STAT_DIMENSIONS.forEach((dim) => {
    const rows = Array.isArray(report[dim]) ? report[dim] : [];
    rows.forEach((row) => {
      if (!row || row.marginal) return;                  // 边缘显著不作为依据
      if ((row.sample_count || 0) < MIN_SAMPLE) return; // 样本太少视为噪声
      const rate = parseFloat(row.layer_rate);
      if (!isFinite(rate)) return;

      if (row.signal === 'pos') {
        const edge = rate - base;
        if (edge > posEdge) {
          posEdge = edge;
          posLabel = row.label;
        }
      } else if (row.signal === 'neg') {
        const edge = base - rate;
        if (edge > negEdge) {
          negEdge = edge;
          negLabel = row.label;
        }
      }
    });
  });

  if (posEdge >= EDGE_THRESHOLD && posEdge >= negEdge) {
    return {
      verdict: 'A',
      verdictText: '偏多',
      detail: `「${posLabel}」层内红盘率高于基准 ${posEdge.toFixed(1)} 个百分点`
    };
  }
  if (negEdge >= EDGE_THRESHOLD) {
    return {
      verdict: 'B',
      verdictText: '偏空',
      detail: `「${negLabel}」层内红盘率低于基准 ${negEdge.toFixed(1)} 个百分点`
    };
  }
  return {
    verdict: 'C',
    verdictText: '中性',
    detail: '各维度未发现明显偏离基准的验证信号'
  };
}

module.exports = { deriveVerdict, EDGE_THRESHOLD, MIN_SAMPLE };
