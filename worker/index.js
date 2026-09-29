/**
 * 稻谷查查1.0 - Cloudflare Worker
 * T+1策略回测 + 5维度归因计算
 */

const TUSHARE_TOKEN = '42f7594e9640ff73a5b018a021a4141ab9012c37d6e6d599bb6221eb';
const TUSHARE_URL = 'https://t.xiaodefa.top/';

const STOCK_MAP = {
  '振华科技': '000733.SZ', '000733': '000733.SZ',
  '立讯精密': '002475.SZ', '002475': '002475.SZ',
  '振华股份': '600267.SH', '600267': '600267.SH',
  '金牛化工': '600722.SH', '600722': '600722.SH',
  '贵州茅台': '600519.SH', '600519': '600519.SH',
  '宁德时代': '300750.SZ', '300750': '300750.SZ',
  '比亚迪': '002594.SZ', '002594': '002594.SZ',
  '中国平安': '601318.SH', '601318': '601318.SH',
};

const STOCK_NAME = {
  '000733': '振华科技', '002475': '立讯精密', '600267': '振华股份',
  '600722': '金牛化工', '600519': '贵州茅台', '300750': '宁德时代',
  '002594': '比亚迪', '601318': '中国平安',
};

const INDUSTRY_MAP = {
  '000733': '元器件', '002475': '电子制造', '600267': '化学制药',
  '600722': '化工', '600519': '白酒', '300750': '新能源汽车',
  '002594': '汽车整车', '601318': '保险',
};

// Tushare API调用
async function tushareCall(apiName, params) {
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

// 解析股票代码
function resolveCode(input) {
  if (/^\d{6}$/.test(input)) {
    const sz = ['000', '002', '300'];
    return sz.includes(input.slice(0, 3)) ? `${input}.SZ` : `${input}.SH`;
  }
  return STOCK_MAP[input] || null;
}

// 计算移动平均
function ma(arr, n) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = 0; j < n; j++) sum += arr[i - j];
    result.push(sum / n);
  }
  return result;
}

// 计算滚动量比均值
function volMa(vols, n) {
  const result = [];
  for (let i = 0; i < vols.length; i++) {
    if (i < n - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = 0; j < n; j++) sum += vols[i - j];
    result.push(sum / n);
  }
  return result;
}

// 主分析函数
async function analyze(stockCode) {
  const codeNum = stockCode.split('.')[0];
  const today = new Date();
  const endDate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

  // 获取K线数据
  const klines = await tushareCall('daily', { ts_code: stockCode, start_date: '20250101', end_date: endDate });
  if (!klines || klines.length === 0) return { error: '获取数据失败' };

  // 转换并排序
  const df = klines.map(k => ({
    date: String(k.trade_date),
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
    vol: parseFloat(k.vol),
    pct_chg: parseFloat(k.pct_chg || 0),
  })).sort((a, b) => a.date.localeCompare(b.date));

  const closes = df.map(d => d.close);
  const vols = df.map(d => d.vol);
  const highs = df.map(d => d.high);
  const lows = df.map(d => d.low);
  const opens = df.map(d => d.open);

  // 计算指标
  const ma5 = ma(closes, 5);
  const ma10 = ma(closes, 10);
  const ma20 = ma(closes, 20);
  const ma60 = ma(closes, 60);
  const ma120 = ma(closes, 120);
  const vMa5 = volMa(vols, 5);

  // 最近60日
  const d60 = df.slice(-60);
  const closes60 = closes.slice(-60);
  const vols60 = vols.slice(-60);
  const highs60 = highs.slice(-60);
  const lows60 = lows.slice(-60);
  const ma5_60 = ma5.slice(-60);
  const ma20_60 = ma20.slice(-60);
  const vMa5_60 = vMa5.slice(-60);

  // 次日收益
  const returns = [];
  for (let i = 0; i < d60.length - 1; i++) {
    returns.push((closes60[i + 1] - closes60[i]) / closes60[i] * 100);
  }
  const highNexts = [];
  for (let i = 0; i < d60.length - 1; i++) {
    highNexts.push((highs60[i + 1] - closes60[i]) / closes60[i] * 100);
  }

  // 策略扫描 - 用d60对应的原始索引
  const results = [];
  const fullOffset = df.length - d60.length; // df中d60[0]对应的索引
  const isYang = d60.map((_, i) => i < d60.length - 1 ? closes60[i] > opens[fullOffset + i] : false);
  const isYin = d60.map((_, i) => i < d60.length - 1 ? closes60[i] < opens[fullOffset + i] : false);

  // bias指标
  const bias5_60 = closes60.map((c, i) => ma5_60[i] ? (c - ma5_60[i]) / ma5_60[i] * 100 : 0);
  const bias10_60 = closes60.map((c, i) => ma10[ma10.length - d60.length + i] ? (c - ma10[ma10.length - d60.length + i]) / ma10[ma10.length - d60.length + i] * 100 : 0);
  const bias20_60 = closes60.map((c, i) => ma20_60[i] ? (c - ma20_60[i]) / ma20_60[i] * 100 : 0);
  const vRatio60 = vols60.map((v, i) => vMa5_60[i] ? v / vMa5_60[i] : 1);

  // 追涨
  for (const [biasArr, biasThresh] of [[bias5_60,3],[bias5_60,5],[bias5_60,8],[bias5_60,10],[bias10_60,3],[bias10_60,5],[bias10_60,8],[bias10_60,10],[bias20_60,3],[bias20_60,5],[bias20_60,8],[bias20_60,10]]) {
    for (const vThresh of [1.2, 1.5, 2.0]) {
      const idx = biasArr === bias5_60 ? 0 : biasArr === bias10_60 ? 1 : 2;
      const biasName = ['bias5','bias10','bias20'][idx];
      const sub = [];
      for (let i = 0; i < returns.length; i++) {
        if (isYang[i] && vRatio60[i] > vThresh && biasArr[i] > biasThresh) sub.push(i);
      }
      if (sub.length < 2) continue;
      const wins = sub.filter(i => returns[i] > 0);
      const wr = wins.length / sub.length * 100;
      const avgW = wins.length ? wins.reduce((s, i) => s + returns[i], 0) / wins.length : 0;
      const losses = sub.filter(i => returns[i] <= 0);
      const avgL = losses.length ? losses.reduce((s, i) => s + Math.abs(returns[i]), 0) / losses.length : 0;
      const E = (wr / 100) * avgW - ((100 - wr) / 100) * avgL;
      results.push({ type: '追涨', bias_cond: `${biasName}>${biasThresh}`, v_cond: `量比>${vThresh}`, N: sub.length, WR: +wr.toFixed(1), AvgWin: +avgW.toFixed(3), AvgHigh: +(sub.reduce((s,i) => s + highNexts[i], 0) / sub.length).toFixed(3), E: +E.toFixed(3) });
    }
  }

  // 低吸
  for (const [biasArr, biasThresh] of [[bias5_60,-5],[bias5_60,-8],[bias5_60,-10],[bias10_60,-5],[bias10_60,-8],[bias10_60,-10],[bias20_60,-5],[bias20_60,-8],[bias20_60,-10]]) {
    for (const vThresh of [0.7, 0.8, 0.9]) {
      const idx = biasArr === bias5_60 ? 0 : biasArr === bias10_60 ? 1 : 2;
      const biasName = ['bias5','bias10','bias20'][idx];
      const sub = [];
      for (let i = 0; i < returns.length; i++) {
        if (isYin[i] && vRatio60[i] < vThresh && biasArr[i] < biasThresh) sub.push(i);
      }
      if (sub.length < 2) continue;
      const wins = sub.filter(i => returns[i] > 0);
      const wr = wins.length / sub.length * 100;
      const avgW = wins.length ? wins.reduce((s, i) => s + returns[i], 0) / wins.length : 0;
      const losses = sub.filter(i => returns[i] <= 0);
      const avgL = losses.length ? losses.reduce((s, i) => s + Math.abs(returns[i]), 0) / losses.length : 0;
      const E = (wr / 100) * avgW - ((100 - wr) / 100) * avgL;
      results.push({ type: '低吸', bias_cond: `${biasName}<${biasThresh}`, v_cond: `量比<${vThresh}`, N: sub.length, WR: +wr.toFixed(1), AvgWin: +avgW.toFixed(3), AvgHigh: +(sub.reduce((s,i) => s + highNexts[i], 0) / sub.length).toFixed(3), E: +E.toFixed(3) });
    }
  }

  results.sort((a, b) => b.E - a.E);
  const top3 = results.slice(0, 3);

  const zhuiE = results.filter(r => r.type === '追涨')[0]?.E ?? -999;
  const dixiE = results.filter(r => r.type === '低吸')[0]?.E ?? -999;

  let verdict, verdictText;
  if (zhuiE > dixiE && zhuiE > 0) { verdict = 'A'; verdictText = '只宜追涨'; }
  else if (dixiE > zhuiE && dixiE > 0) { verdict = 'B'; verdictText = '只宜低吸'; }
  else { verdict = 'C'; verdictText = '不适合做T+1'; }

  // 全局统计
  const lastClose = closes60[closes60.length - 1];
  const firstClose = closes60[0];
  const highMax = Math.max(...highs60);
  const lowMin = Math.min(...lows60);
  const yangDays = d60.filter((d, i) => i < closes60.length - 1 && closes60[i] > opens[opens.length - d60.length + i]).length;
  const yinDays = d60.filter((d, i) => i < closes60.length - 1 && closes60[i] < opens[opens.length - d60.length + i]).length;
  const volUpDays = vRatio60.filter(v => v > 1.2).length;
  const volDownDays = vRatio60.filter(v => v < 0.8).length;

  const globalStats = {
    '区间': `${d60[0].date} ~ ${d60[d60.length-1].date}`,
    '区间涨跌': `${((lastClose - firstClose) / firstClose * 100).toFixed(2)}%`,
    '最高价': +highMax.toFixed(2),
    '最低价': +lowMin.toFixed(2),
    '阳线天数': yangDays,
    '阴线天数': yinDays,
    '放量天数': volUpDays,
    '缩量天数': volDownDays,
  };

  // 股性画像
  const last = d60[d60.length - 1];
  const priceHigh60 = Math.max(...highs60);
  const priceLow60 = Math.min(...lows60);
  const ma5Last = ma5_60[ma5_60.length - 1];
  const ma20Last = ma20_60[ma20_60.length - 1];
  const closeVsMa5 = ma5Last ? (lastClose - ma5Last) / ma5Last * 100 : 0;
  const closeVsMa20 = ma20Last ? (lastClose - ma20Last) / ma20Last * 100 : 0;

  let trendStatus;
  if (closeVsMa5 > 0 && closeVsMa20 > 0) trendStatus = '多头排列';
  else if (closeVsMa5 < 0 && closeVsMa20 < 0) trendStatus = '空头排列';
  else trendStatus = '震荡整理';

  const limitUpCount = df.filter(d => d.pct_chg > 9.9).length;
  const avgAmp = d60.reduce((s, d, i) => {
    const openI = opens[opens.length - d60.length + i];
    return s + (highs60[i] - lows60[i]) / openI * 100;
  }, 0) / d60.length;

  const stockProfile = {
    trend_status: trendStatus,
    close_vs_ma5: `${closeVsMa5.toFixed(2)}%`,
    close_vs_ma20: `${closeVsMa20.toFixed(2)}%`,
    current_volume_ratio: +vRatio60[vRatio60.length - 1].toFixed(2),
    yangxian_days: yangDays,
    yinxian_days: yinDays,
    limit_up_count: limitUpCount,
    avg_amplitude: +avgAmp.toFixed(2),
    price_high: `${priceHigh60.toFixed(2)}元`,
    price_low: `${priceLow60.toFixed(2)}元`,
    dist_high: `${((lastClose - priceHigh60) / priceHigh60 * 100).toFixed(1)}%`,
    dist_low: `${((lastClose - priceLow60) / priceLow60 * 100).toFixed(1)}%`,
  };

  // 维度一：板块
  const industry = INDUSTRY_MAP[codeNum] || '其他';
  const lastPct = last.pct_chg;
  const alpha = lastPct - 0; // 简化
  const dim1 = {
    industry,
    sector_pct: `${lastPct >= 0 ? '+' : ''}${lastPct.toFixed(2)}%`,
    sector_comment: alpha > 0 ? '个股强于板块' : '个股弱于板块',
    alpha: `${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`,
    alpha_comment: Math.abs(alpha) < 1 ? '无明显超额收益' : (alpha > 0 ? '正向Alpha' : '负向Alpha'),
  };

  // 维度二：竞价
  const t1 = d60[d60.length - 2] || last;
  const t1Open = opens[opens.length - d60.length + d60.length - 2] || t1.close;
  const t1Close = t1.close;
  const t1High = t1.high;
  const t1Low = t1.low;
  const t1Range = t1High - t1Low || 1;
  const auctionPct = t1Close ? (last.open - t1Close) / t1Close * 100 : 0;
  const upperShadow = (t1High - t1Close) / t1Range;
  const lowerShadow = (t1Close - t1Low) / t1Range;
  const t1IsYang = t1Close > t1Open;

  let dim2 = {
    auction_open_pct: `${auctionPct >= 0 ? '+' : ''}${auctionPct.toFixed(2)}%`,
    auction_comment: auctionPct > 2 ? '高开，有异动' : auctionPct < -2 ? '低开，抛压明显' : '正常平开',
    t1_candle: (t1IsYang ? '阳线' : '阴线') + (upperShadow > 0.5 ? '+长上影' : lowerShadow > 0.5 ? '+长下影' : ''),
    candle_comment: upperShadow > 0.5 ? '上方有压力' : lowerShadow > 0.5 ? '下方有支撑' : '正常',
    t1_tail_action: upperShadow > 0.6 ? '尾盘冲高回落' : lowerShadow > 0.6 ? '尾盘企稳' : '尾盘正常',
    tail_comment: upperShadow > 0.6 ? '压力明显' : lowerShadow > 0.6 ? '资金托底' : '无异动',
  };

  // 维度三：筹码
  const low250 = Math.min(...lows);
  const high250 = Math.max(...highs);
  const winRate = (lastClose - low250) / (high250 - low250) * 100;
  const ma120Last = ma120[ma120.length - 1];
  const ma250Last = ma(closes, 250)[closes.length - 1];
  const distMa120 = ma120Last ? (lastClose - ma120Last) / ma120Last * 100 : null;
  const distMa250 = ma250Last ? (lastClose - ma250Last) / ma250Last * 100 : null;

  const wrCmt = winRate < 20 ? '极度低位套牢区' : winRate < 50 ? '低位区域' : winRate > 80 ? '高位区域' : '中间位置';
  const [resistance, resCmt] = (!distMa120 || distMa120 < -10) ? ['相对低位', '下方有支撑，上方有空间']
    : (distMa120 && distMa120 > 10) ? ['相对高位', '上方有压力']
    : ['中间位置', '上下均有空间'];

  const dim3 = {
    win_rate: `${winRate.toFixed(1)}%`,
    win_rate_comment: wrCmt,
    dist_ma120: distMa120 !== null ? `${distMa120 >= 0 ? '+' : ''}${distMa120.toFixed(2)}%` : 'N/A',
    ma120_comment: distMa120 !== null ? `股价在半年线${distMa120 > 0 ? '上方' : '下方'}` : '数据不足',
    dist_ma250: distMa250 !== null ? `${distMa250 >= 0 ? '+' : ''}${distMa250.toFixed(2)}%` : 'N/A',
    ma250_comment: distMa250 !== null ? `股价在年线${distMa250 > 0 ? '上方' : '下方'}` : '数据不足',
    resistance,
    resistance_comment: resCmt,
  };

  // 维度四：情绪
  let lu = 0, ld = 0, hs300Pct = 0;
  try {
    const luD = await tushareCall('limit_list_d', { trade_date: endDate, limit_type: 'U' });
    const ldD = await tushareCall('limit_list_d', { trade_date: endDate, limit_type: 'D' });
    lu = luD?.length || 0;
    ld = ldD?.length || 0;
    const idx = await tushareCall('index_daily', { ts_code: '000300.SH', start_date: endDate, end_date: endDate });
    hs300Pct = idx?.[0]?.pct_chg || 0;
  } catch(e) {}

  const [sentiment, sentCmt] = lu >= 50 && ld < 10 ? ['亢奋', '市场做多情绪高涨'] : ld > 30 || lu < 5 ? ['退潮', '市场情绪低迷'] : ['中性', '市场平稳'];

  const dim4 = {
    limit_up: lu,
    limit_down: ld,
    sentiment,
    sentiment_comment: sentCmt,
    hs300_pct: `${hs300Pct >= 0 ? '+' : ''}${hs300Pct.toFixed(2)}%`,
  };

  // 维度五：资金
  let marginBal = 0, marginChg = 0, blockTrade = '无';
  try {
    const monthStart = endDate.slice(0, 6) + '01';
    const margin = await tushareCall('margin_detail', { ts_code: stockCode, start_date: monthStart, end_date: endDate });
    if (margin && margin.length >= 2) {
      const first = parseFloat(margin[0].rzye);
      const last2 = parseFloat(margin[margin.length - 1].rzye);
      marginChg = first ? (last2 - first) / first * 100 : 0;
      marginBal = last2 / 1e8;
    }
    const block = await tushareCall('block_trade', { ts_code: stockCode, start_date: monthStart, end_date: endDate });
    const bc = block?.length || 0;
    blockTrade = bc > 0 ? `近30日${bc}笔` : '无';
  } catch(e) {}

  const dim5 = {
    margin_balance: marginBal > 0 ? `${marginBal.toFixed(2)}亿元` : 'N/A',
    margin_change: marginChg !== 0 ? `${marginChg >= 0 ? '+' : ''}${marginChg.toFixed(2)}%` : 'N/A',
    margin_comment: marginChg > 0 ? '杠杆资金小幅加仓' : marginChg < 0 ? '小幅减仓' : '持平',
    block_trade: blockTrade,
  };

  // 综合结论
  const conclusion = {
    trend: trendStatus,
    strategy: verdictText,
    sector: `${industry}，${alpha > 0 ? '强于板块' : '跟随板块'}`,
    chip: `${winRate.toFixed(1)}%（${wrCmt}），${resistance}`,
    sentiment: `${sentiment}（${sentCmt}）`,
    fund: marginChg !== 0 ? `融资${marginChg >= 0 ? '+' : ''}${marginChg.toFixed(2)}%` : '融资数据待更新',
  };

  return {
    stock_code: stockCode,
    stock_name: STOCK_NAME[codeNum] || codeNum,
    verdict,
    verdict_text: verdictText,
    verdict_reason: top3[0] ? `${top3[0].type}信号，${top3[0].bias_cond}` : '无有效信号',
    top3_strategies: top3,
    global_stats: globalStats,
    dow_stats: {},
    stock_profile: stockProfile,
    dim1, dim2, dim3, dim4, dim5,
    conclusion,
  };
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ code: 405, msg: 'Method Not Allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  try {
    const body = await request.json();
    const { stock_code } = body;

    if (!stock_code) {
      return new Response(JSON.stringify({ code: 400, msg: '缺少stock_code参数' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const thscode = resolveCode(stock_code);
    if (!thscode) {
      return new Response(JSON.stringify({ code: 404, msg: '无法识别股票代码' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const report = await analyze(thscode);
    if (report.error) {
      return new Response(JSON.stringify({ code: 500, msg: report.error }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ code: 0, data: report }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    return new Response(JSON.stringify({ code: 500, msg: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
