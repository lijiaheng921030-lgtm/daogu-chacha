/**
 * 报告数据的前端预处理。
 *
 * 抽成独立模块而不是塞在页面里，是为了让离线预览（tools/render-preview.js）
 * 和真机页面走同一份逻辑 —— 否则预览里好看的效果到真机上就不对了。
 */

// 所有统计维度的字段名，顺序即页面展示顺序
const STAT_DIMENSIONS = [
  'vol_stats', 'ma5_stats', 'ma20_stats', 'turn_stats', 'dist_stats',
  'vwap_stats', 'shape_stats', 'auc_stats', 'wick_stats', 'fenshi_stats',
  'cond_stats'
];

/**
 * p 值格式化：
 *   0.0001 → p<0.001（极显著，直接写阈值更清楚）
 *   0.0285 → p=0.029
 */
function formatP(p) {
  if (p == null || !isFinite(p)) return '';
  if (p < 0.001) return 'p<0.001';
  return 'p=' + p.toFixed(3);
}

/**
 * 给报告里的每一行补上验证统计量文案。
 *
 * 后端把跨股票验证的原始统计量透了出来（v_p / v_z / v_stocks），
 * 这里整理成一句人能读懂的说明。
 *
 * 目的是让用户能自己核对「这个信号到底是不是噪声」，
 * 而不是只能看到一句「✅已验证」然后选择信或不信。
 *
 * 统计量不放进表格的标签列 —— 标签列只有 220rpx 宽，
 * 塞进去会换行成 3 行，把表格行高撑得参差不齐。
 * 改为按维度收集成 verified 数组，在表格下方单独一块展示。
 */
function enrichReport(report) {
  if (!report || typeof report !== 'object') return report;

  STAT_DIMENSIONS.forEach((dim) => {
    const rows = report[dim];
    if (!Array.isArray(rows)) return;

    const verified = [];
    rows.forEach((row) => {
      if (!row || row.v_p == null) {
        row.v_text = '';
        return;
      }
      const parts = [];
      parts.push(formatP(row.v_p));
      if (row.v_z != null && isFinite(row.v_z)) {
        parts.push('z=' + row.v_z.toFixed(2));
      }
      if (row.v_stocks != null) {
        parts.push(row.v_stocks + '/10只方向一致');
      }
      if (row.marginal) {
        parts.push('仅边缘显著');
      }
      row.v_text = parts.join(' · ');
      verified.push({
        label: row.label,
        dir: row.signal,
        marginal: !!row.marginal,
        v_text: row.v_text
      });
    });

    // 每个维度单独存一份，页面在对应表格下方渲染
    report[dim + '_verified'] = verified;
  });

  return report;
}

module.exports = { enrichReport, formatP, STAT_DIMENSIONS };
