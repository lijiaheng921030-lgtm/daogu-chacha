/**
 * 构造一份结构与真实 /api/statAnalyze 响应完全一致的报告样本。
 *
 * 上游 Tushare 不可用时，用它做离线渲染与联调。
 * 字段命名、类型、层数都按真实接口对齐（见 server/index.js 的 res.json）。
 *
 * 验证统计量（v_p / v_z / v_stocks）直接从 server/validated.js 取真值，
 * 保证预览里的 ✅/⚠ 标记和统计量与生产环境完全一致 ——
 * 手写 label 一旦和 validated.js 里的对不上，标记就会全部落空。
 */

const validated = require('../server/validated.js');

function layer(label, red, green, rate, dim, extra = {}) {
  const sample = red + green;
  // 从 validated.js 取该层的真实验证结论
  const st = validated.verifyStatsOf(dim, label);
  return Object.assign({
    label,
    red_count: red,
    red_ratio: (red / sample * 100).toFixed(1),
    red_avg: (1.8 + ((label.length * 7) % 12) / 10).toFixed(2),
    green_count: green,
    green_ratio: (green / sample * 100).toFixed(1),
    green_avg: (0.8 + ((label.length * 3) % 10) / 10).toFixed(2),
    sample_count: sample,
    layer_rate: rate.toFixed(1),
    signal: st ? st.dir : null,
    marginal: st ? st.marginal : false,
    v_p: st ? st.p : null,
    v_z: st ? st.z : null,
    v_stocks: st ? st.stocks : null,
    isBestRatio: false,
    isBestAvg: false
  }, extra);
}

function buildFixture(opts = {}) {
  // 支持参数化股票，方便针对具体股票生成结构一致的演示结果。
  // 不传参时默认振华科技，向后兼容。
  const stockCode = opts.stock_code || '000733.SZ';
  const stockName = opts.stock_name || '振华科技';
  const dataStart = opts.data_start_date || '2026-04-28';
  const dataEnd = opts.data_end_date || '2026-10-30';

  const totalRed = opts.total_red || 58;
  const totalGreen = opts.total_green || 62;

  return {
    stock_code: stockCode,
    stock_name: stockName,
    days: opts.days || 120,
    headline: opts.headline || '成功率最高：收盘价跌破均价线+收在日内最低位+缩量（60.0%）',
    data_start_date: dataStart,
    data_end_date: dataEnd,
    data_is_stale: opts.data_is_stale || false,
    data_stale_days: opts.data_stale_days || 0,
    total_red: totalRed,
    total_green: totalGreen,
    vol_stats: [
      layer('缩量(<0.7)', 14, 9, 60.9, 'vol', { isBestRatio: true }),
      layer('正常(0.7-1.2)', 18, 20, 47.4, 'vol'),
      layer('放量(1.2-2.0)', 16, 19, 45.7, 'vol'),
      layer('巨量(>2.0)', 12, 18, 40.0, 'vol')
    ],
    ma5_stats: [
      layer('股价在5日线上方（偏离>5%）', 20, 22, 47.6, 'ma5'),
      layer('股价在5日线上方（0~5%）', 21, 24, 46.7, 'ma5'),
      layer('股价在5日线下方（0~-5%）', 11, 10, 52.4, 'ma5'),
      layer('股价在5日线下方（偏离<-5%）', 6, 6, 50.0, 'ma5')
    ],
    ma20_stats: [
      layer('股价在20日线上方（偏离>10%）', 22, 23, 48.9, 'ma20'),
      layer('股价在20日线上方（0~10%）', 20, 19, 51.3, 'ma20'),
      layer('股价在20日线下方（0~-10%）', 10, 12, 45.5, 'ma20'),
      layer('股价在20日线下方（偏离<-10%）', 6, 8, 42.9, 'ma20')
    ],
    // 换手率维度：未做跨股票验证（turn 在 validated.js 里是空对象），不标信号
    turn_stats: [
      layer('低换(<1%)', 16, 18, 47.1, 'turn'),
      layer('正常(1-3%)', 28, 30, 48.3, 'turn', { isBestRatio: true }),
      layer('高换(3-6%)', 9, 9, 50.0, 'turn'),
      layer('巨量换手(>6%)', 5, 5, 50.0, 'turn')
    ],
    dist_stats: [
      layer('前日跌超5%', 5, 7, 41.7, 'dist'),
      layer('前日跌2~5%', 11, 13, 45.8, 'dist'),
      layer('1~3%', 8, 6, 57.1, 'dist'),
      layer('前日涨跌<2%', 22, 24, 47.8, 'dist'),
      layer('前日涨2~5%', 9, 10, 47.4, 'dist'),
      layer('前日涨超5%', 5, 6, 45.5, 'dist')
    ],
    vwap_stats: [
      layer('收盘价高于当日均价线0.5%以上', 26, 32, 44.8, 'vwap'),
      layer('收盘价在均价线±0.5%', 18, 17, 51.4, 'vwap'),
      layer('收盘价低于当日均价线0.5%以上', 14, 13, 51.9, 'vwap', { isBestRatio: true })
    ],
    shape_stats: [
      layer('A 弱势收盘（收在日内最低位且破均价线）', 19, 15, 55.9, 'shape', { isBestRatio: true }),
      layer('B 中性收盘', 18, 21, 46.2, 'shape'),
      layer('C 强势收盘', 12, 15, 44.4, 'shape'),
      layer('D 强势收盘（收在日内最高位且站上均价线）', 9, 11, 45.0, 'shape')
    ],
    auc_stats: [
      layer('竞价缩量（<近5日竞价均量0.8倍）', 16, 18, 47.1, 'auc'),
      layer('竞价量比 0.8~1.2', 20, 18, 52.6, 'auc'),
      layer('竞价温和放量（1.2~2.5倍）', 15, 9, 62.5, 'auc', { isBestRatio: true }),
      layer('竞价过度放量（≥2.5倍）', 7, 8, 46.7, 'auc')
    ],
    wick_stats: [
      layer('下影线<0.5%', 30, 30, 50.0, 'wick'),
      layer('下影线0.5~1.5%', 18, 20, 47.4, 'wick'),
      layer('盘中杀跌后拉回（下影线>1.5%）', 10, 15, 40.0, 'wick')
    ],
    fenshi_stats: [
      layer('S1 早盘冲高回落', 18, 16, 52.9, 'fenshi', { isBestRatio: true }),
      layer('S2 早盘探底后回升', 14, 19, 42.4, 'fenshi'),
      layer('S3 全天单边上行', 12, 12, 50.0, 'fenshi'),
      layer('S4 全天单边下行', 9, 11, 45.0, 'fenshi'),
      layer('S5 均价线上翘（重心上移）', 13, 18, 41.9, 'fenshi'),
      layer('S6 尾盘拉升', 8, 9, 47.1, 'fenshi'),
      layer('S7 横盘整理（均价线走平）', 15, 15, 50.0, 'fenshi')
    ],
    cond_stats: [
      layer('收盘价跌破均价线 + 收在日内最低位 + 缩量', 9, 6, 60.0, 'cond', { isBestRatio: true }),
      layer('集合竞价温和放量（1.2~2.5倍） + 当日缩量', 7, 5, 58.3, 'cond'),
      layer('收盘价跌破当日均价线 + 股价在5日线下方', 6, 5, 54.5, 'cond'),
      layer('收盘价跌破当日均价线 + 缩量', 5, 4, 55.6, 'cond'),
      layer('收盘价跌破当日均价线 + 缩量 + 股价在5日线下方', 4, 3, 57.1, 'cond')
    ],
    conclusions: {
      vol: '【成功率最高】缩量(<0.7)（层内红盘率60.9%，23次）；【涨幅最高】放量(1.2-2.0)（红盘均涨2.31%）',
      turn: '换手率维度未做跨股票验证（各股流通盘不同，口径不可跨股比较），只做本股内分布参考。本股换手率分层中「正常(1-3%)」层内红盘率最高（48.3%，58 次样本），但该结论仅在本股历史内有效',
      ma5: '【成功率最高】股价在5日线下方（0~-5%）（层内红盘率52.4%，21次）；【涨幅最高】股价在5日线上方（0~5%）（红盘均涨2.64%）',
      ma20: '【成功率最高】股价在20日线上方（0~10%）（层内红盘率51.3%，39次）；【涨幅最高】股价在20日线上方（偏离>10%）（红盘均涨2.77%）',
      dist: '【成功率最高】前日涨跌<2%（层内红盘率51.9%，54次）；【涨幅最高】前日涨跌<2%（红盘均涨2.55%）',
      vwap: '【成功率最高】收盘价低于均价线0.5%以上（层内红盘率51.9%，27次）；【涨幅最高】收盘价低于均价线0.5%以上（红盘均涨2.42%）',
      shape: '【成功率最高】A 弱势收盘（收在日内最低位且破均价线）（层内红盘率55.9%，34次）；【涨幅最高】A 弱势收盘（收在日内最低位且破均价线）（红盘均涨2.71%）',
      auc: '【成功率最高】竞价温和放量（1.2~2.5倍）（层内红盘率62.5%，24次）；【涨幅最高】竞价温和放量（1.2~2.5倍）（红盘均涨2.48%）',
      wick: '【成功率最高】下影线<0.5%（层内红盘率50.0%，60次）；【涨幅最高】下影线<0.5%（红盘均涨2.19%）；看空信号：下影线>1.5%（本股票层内红盘率40.0%，跨股检验 p=0.002）',
      fenshi: '【成功率最高】S1 早盘冲高回落（层内红盘率52.9%，34次）；本维度没有验证过的涨幅层——各形态的「红盘日均涨」都落在 1.89%~2.72% 之间，和全样本基准 2.07% 基本一致',
      cond: '【成功率最高】收盘价跌破均价线+收在日内最低位+缩量（层内红盘率60.0%，15次）；【涨幅最高】收盘价跌破均价线+收在日内最低位+缩量（红盘均涨2.44%）',
      overall: '综合来看，最优买入条件为【收盘价跌破均价线+收在日内最低位+缩量】，红盘均涨最高（2.44%）；若追求稳定则关注【竞价温和放量（1.2~2.5倍）】（层内红盘率62.5%）。分时走势方面，真实5分钟线分出的日内形态最关键的是【S1 早盘冲高回落】，收盘位置×均价线的交叉形态参考【A 弱势收盘（收在日内最低位且破均价线）】（层内红盘率55.9%），收盘价与当日均价线的位置参考【收盘价低于均价线0.5%以上】，集合竞价量能参考【竞价温和放量（1.2~2.5倍）】，长下影形态参考【下影线>1.5%】；量能参考【放量(1.2-2.0)】，5日线参考【股价在5日线上方（0~5%）】。注意：只有通过跨股票验证的层才会被标为「最高」，没验证过的维度会直说「无稳定信号」，不用单股噪声层充数。'
    },
    top10: [
      { date: '2026-09-18', today_pct: '-3.21', next_pct: '5.67', vol_ratio: '0.68', vs_ma5: '-6.20', vs_ma20: '-9.40', turnover: '3.41', vwap_diff: '-1.84', close_pos: '3', low_shadow: '2.15', auc_ratio: '1.85', fenshi: 'S1 早盘冲高回落' },
      { date: '2026-08-07', today_pct: '-2.05', next_pct: '4.92', vol_ratio: '0.75', vs_ma5: '-4.10', vs_ma20: '-6.85', turnover: '2.87', vwap_diff: '-1.22', close_pos: '5', low_shadow: '0.85', auc_ratio: '2.10', fenshi: 'S1 早盘冲高回落' },
      { date: '2026-10-09', today_pct: '-1.88', next_pct: '4.35', vol_ratio: '0.72', vs_ma5: '-3.55', vs_ma20: '-5.20', turnover: '3.02', vwap_diff: '-0.95', close_pos: '8', low_shadow: '0.42', auc_ratio: '1.62', fenshi: 'S3 全天单边上行' },
      { date: '2026-07-22', today_pct: '-4.12', next_pct: '3.98', vol_ratio: '0.64', vs_ma5: '-8.30', vs_ma20: '-12.10', turnover: '4.15', vwap_diff: '-2.40', close_pos: '2', low_shadow: '1.05', auc_ratio: '1.48', fenshi: 'S1 早盘冲高回落' },
      { date: '2026-09-02', today_pct: '-1.55', next_pct: '3.71', vol_ratio: '0.81', vs_ma5: '-2.90', vs_ma20: '-4.65', turnover: '2.63', vwap_diff: '-0.71', close_pos: '12', low_shadow: '0.36', auc_ratio: '1.35', fenshi: 'S2 早盘探底后回升' },
      { date: '2026-08-25', today_pct: '-2.77', next_pct: '3.44', vol_ratio: '0.69', vs_ma5: '-5.60', vs_ma20: '-8.30', turnover: '3.28', vwap_diff: '-1.63', close_pos: '6', low_shadow: '1.68', auc_ratio: '1.55', fenshi: 'S1 早盘冲高回落' },
      { date: '2026-06-30', today_pct: '-1.42', next_pct: '3.10', vol_ratio: '0.85', vs_ma5: '-2.15', vs_ma20: '-3.40', turnover: '2.44', vwap_diff: '-0.62', close_pos: '15', low_shadow: '0.28', auc_ratio: '1.28', fenshi: 'S7 横盘整理' },
      { date: '2026-10-16', today_pct: '-3.05', next_pct: '2.87', vol_ratio: '0.71', vs_ma5: '-7.10', vs_ma20: '-10.55', turnover: '3.76', vwap_diff: '-2.05', close_pos: '4', low_shadow: '1.92', auc_ratio: '1.72', fenshi: 'S1 早盘冲高回落' },
      { date: '2026-07-08', today_pct: '-2.30', next_pct: '2.55', vol_ratio: '0.66', vs_ma5: '-4.85', vs_ma20: '-7.20', turnover: '2.95', vwap_diff: '-1.35', close_pos: '7', low_shadow: '0.74', auc_ratio: '1.40', fenshi: 'S4 全天单边下行' },
      { date: '2026-09-25', today_pct: '-1.66', next_pct: '2.31', vol_ratio: '0.79', vs_ma5: '-3.40', vs_ma20: '-5.05', turnover: '2.71', vwap_diff: '-0.88', close_pos: '10', low_shadow: '0.51', auc_ratio: '1.52', fenshi: 'S6 尾盘拉升' }
    ]
  };
}

module.exports = { buildFixture, layer };
