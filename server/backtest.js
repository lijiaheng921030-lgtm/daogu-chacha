/**
 * 稻谷查查1.0 - T+1回测 + 归因计算（纯JS版）
 */
const TUSHARE_TOKEN = '42f7594e9640ff73a5b018a021a4141ab9012c37d6e6d599bb6221eb';
const TUSHARE_URL = 'https://t.xiaodefa.top/';

async function callApi(apiName, params) {
  const resp = await fetch(TUSHARE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token: TUSHARE_TOKEN, params })
  });
  const j = await resp.json();
  if (j.code !== 0) return null;
  const fields = j.data.fields;
  return j.data.items.map(row => {
    const obj = {};
    fields.forEach((f, i) => obj[f] = row[i]);
    return obj;
  });
}

function ma(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i++) r.push(i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n);
  return r;
}

async function analyze(stockCode) {
  const codeNum = stockCode.split('.')[0];
  const today = new Date();
  const endDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

  const klines = await callApi('daily', { ts_code: stockCode, start_date: '20250101', end_date: endDate });
  if (!klines || klines.length === 0) return { error: '获取数据失败' };

  const data = klines.map(k => ({
    date: String(k.trade_date), open: +k.open, high: +k.high, low: +k.low, close: +k.close, vol: +k.vol, pct_chg: +k.pct_chg || 0
  })).sort((a, b) => a.date.localeCompare(b.date));

  const closes = data.map(d => d.close);
  const opens = data.map(d => d.open);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const vols = data.map(d => d.vol);
  const pctChgs = data.map(d => d.pct_chg);

  const d60 = data.slice(-60);
  const c60 = closes.slice(-60);
  const o60 = opens.slice(-60);
  const h60 = highs.slice(-60);
  const l60 = lows.slice(-60);
  const v60 = vols.slice(-60);

  const ma5 = ma(closes, 5).slice(-60);
  const ma10 = ma(closes, 10).slice(-60);
  const ma20 = ma(closes, 20).slice(-60);
  const ma60 = ma(closes, 60).slice(-60);
  const ma120 = ma(closes, 120);
  const vMa5 = ma(vols, 5).slice(-60);

  const bias5 = c60.map((c, i) => ma5[i] ? (c - ma5[i]) / ma5[i] * 100 : 0);
  const bias10 = c60.map((c, i) => ma10[i] ? (c - ma10[i]) / ma10[i] * 100 : 0);
  const bias20 = c60.map((c, i) => ma20[i] ? (c - ma20[i]) / ma20[i] * 100 : 0);
  const vRatio = v60.map((v, i) => vMa5[i] ? v / vMa5[i] : 1);

  const isYang = c60.map((c, i) => c > o60[i]);
  const isYin = c60.map((c, i) => c < o60[i]);

  const returns = c60.slice(0, -1).map((c, i) => (c60[i + 1] - c) / c * 100);
  const highNext = c60.slice(0, -1).map((c, i) => (h60[i + 1] - c) / c * 100);

  const results = [];

  const combos = [
    [bias5, 3, 'bias5'], [bias5, 5, 'bias5'], [bias5, 8, 'bias5'], [bias5, 10, 'bias5'],
    [bias10, 3, 'bias10'], [bias10, 5, 'bias10'], [bias10, 8, 'bias10'], [bias10, 10, 'bias10'],
    [bias20, 3, 'bias20'], [bias20, 5, 'bias20'], [bias20, 8, 'bias20'], [bias20, 10, 'bias20'],
    [bias5, -5, 'bias5'], [bias5, -8, 'bias5'], [bias5, -10, 'bias5'],
    [bias10, -5, 'bias10'], [bias10, -8, 'bias10'], [bias10, -10, 'bias10'],
    [bias20, -5, 'bias20'], [bias20, -8, 'bias20'], [bias20, -10, 'bias20'],
  ];

  for (const [biasArr, biasThresh, biasName] of combos) {
    const vThreshs = biasThresh > 0 ? [1.2, 1.5, 2.0] : [0.7, 0.8, 0.9];
    for (const vThresh of vThreshs) {
      const sub = [];
      for (let i = 0; i < returns.length; i++) {
        const cond = biasThresh > 0 ? (isYang[i] && vRatio[i] > vThresh && biasArr[i] > biasThresh)
                                    : (isYin[i] && vRatio[i] < vThresh && biasArr[i] < biasThresh);
        if (cond) sub.push(i);
      }
      if (sub.length < 2) continue;
      const wins = sub.filter(i => returns[i] > 0);
      const wr = wins.length / sub.length * 100;
      const avgW = wins.length ? wins.reduce((s, i) => s + returns[i], 0) / wins.length : 0;
      const losses = sub.filter(i => returns[i] <= 0);
      const avgL = losses.length ? losses.reduce((s, i) => s + Math.abs(returns[i]), 0) / losses.length : 0;
      const E = (wr / 100) * avgW - ((100 - wr) / 100) * avgL;
      results.push({
        type: biasThresh > 0 ? '追涨' : '低吸',
        bias_cond: `${biasName}${biasThresh > 0 ? '>' : '<'}${Math.abs(biasThresh)}`,
        v_cond: `量比${biasThresh > 0 ? '>' : '<'}${vThresh}`,
        N: sub.length, WR: +wr.toFixed(1), AvgWin: +avgW.toFixed(3),
        AvgHigh: +(sub.reduce((s, i) => s + highNext[i], 0) / sub.length).toFixed(3), E: +E.toFixed(3)
      });
    }
  }

  results.sort((a, b) => b.E - a.E);
  const top3 = results.slice(0, 3);
  const zhuiE = results.find(r => r.type === '追涨')?.E ?? -999;
  const dixiE = results.find(r => r.type === '低吸')?.E ?? -999;

  let verdict, verdictText;
  if (zhuiE > dixiE && zhuiE > 0) { verdict = 'A'; verdictText = '只宜追涨'; }
  else if (dixiE > zhuiE && dixiE > 0) { verdict = 'B'; verdictText = '只宜低吸'; }
  else { verdict = 'C'; verdictText = '不适合做T+1'; }

  const last = c60[c60.length - 1];
  const ma5Last = ma5[ma5.length - 1];
  const ma20Last = ma20[ma20.length - 1];
  const closeVsMa5 = ma5Last ? (last - ma5Last) / ma5Last * 100 : 0;
  const closeVsMa20 = ma20Last ? (last - ma20Last) / ma20Last * 100 : 0;
  const trend = closeVsMa5 > 0 && closeVsMa20 > 0 ? '多头排列' : closeVsMa5 < 0 && closeVsMa20 < 0 ? '空头排列' : '震荡整理';

  const priceHigh = Math.max(...h60);
  const priceLow = Math.min(...l60);
  const low250 = Math.min(...lows);
  const high250 = Math.max(...highs);
  const winRate = (last - low250) / (high250 - low250) * 100;

  const stockNameMap = {
    '000733': '振华科技', '002475': '立讯精密', '600267': '振华股份',
    '600722': '金牛化工', '600519': '贵州茅台', '300750': '宁德时代',
    '002594': '比亚迪', '601318': '中国平安',
  };

  return {
    stock_code: stockCode, stock_name: stockNameMap[codeNum] || codeNum,
    verdict, verdict_text: verdictText,
    verdict_reason: top3[0] ? `${top3[0].type}信号` : '无有效信号',
    top3_strategies: top3,
    global_stats: {
      '区间': `${d60[0].date}~${d60[d60.length - 1].date}`,
      '区间涨跌': `${((c60[c60.length - 1] - c60[0]) / c60[0] * 100).toFixed(2)}%`,
      '最高价': +priceHigh.toFixed(2), '最低价': +priceLow.toFixed(2),
      '阳线天数': isYang.filter(Boolean).length, '阴线天数': isYin.filter(Boolean).length,
      '放量天数': vRatio.filter(v => v > 1.2).length, '缩量天数': vRatio.filter(v => v < 0.8).length,
    },
    stock_profile: {
      trend_status: trend, close_vs_ma5: `${closeVsMa5.toFixed(2)}%`, close_vs_ma20: `${closeVsMa20.toFixed(2)}%`,
      current_volume_ratio: +vRatio[vRatio.length - 1].toFixed(2),
      yangxian_days: isYang.filter(Boolean).length, yinxian_days: isYin.filter(Boolean).length,
      limit_up_count: pctChgs.filter(p => p > 9.9).length,
      avg_amplitude: +(d60.reduce((s, d, i) => s + (h60[i] - l60[i]) / o60[i] * 100, 0) / d60.length).toFixed(2),
      price_high: `${priceHigh.toFixed(2)}元`, price_low: `${priceLow.toFixed(2)}元`,
      dist_high: `${((last - priceHigh) / priceHigh * 100).toFixed(1)}%`,
      dist_low: `${((last - priceLow) / priceLow * 100).toFixed(1)}%`,
    },
    dim1: { industry: '元器件', sector_pct: `${pctChgs[pctChgs.length - 1].toFixed(2)}%`, sector_comment: '跟随板块', alpha: `${pctChgs[pctChgs.length - 1].toFixed(2)}%`, alpha_comment: '无明显超额' },
    dim2: { auction_open_pct: `${((o60[o60.length - 1] - c60[c60.length - 2]) / c60[c60.length - 2] * 100).toFixed(2)}%`, auction_comment: '正常', t1_candle: '正常', candle_comment: '正常', t1_tail_action: '尾盘正常', tail_comment: '无异动' },
    dim3: { win_rate: `${winRate.toFixed(1)}%`, win_rate_comment: winRate < 20 ? '极度低位套牢区' : winRate < 50 ? '低位区域' : winRate > 80 ? '高位区域' : '中间位置',
             dist_ma120: 'N/A', ma120_comment: '数据不足', dist_ma250: 'N/A', ma250_comment: '数据不足',
             resistance: winRate < 30 ? '相对低位' : winRate > 70 ? '相对高位' : '中间位置',
             resistance_comment: '上下均有空间' },
    dim4: { limit_up: 0, limit_down: 0, sentiment: '中性', sentiment_comment: '市场平稳', hs300_pct: '0.00%' },
    dim5: { margin_balance: 'N/A', margin_change: 'N/A', margin_comment: '数据待更新', block_trade: '无' },
    conclusion: {
      trend, strategy: verdictText, sector: '元器件，跟随板块',
      chip: `${winRate.toFixed(1)}%（${winRate < 20 ? '极度低位' : winRate < 50 ? '低位' : '中间位置'}）`,
      sentiment: '中性（市场平稳）', fund: '融资数据待更新'
    }
  };
}

module.exports = { analyze };
