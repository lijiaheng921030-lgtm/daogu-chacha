const express = require('express');
const cors = require('cors');
const { analyze } = require('./backtest.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || '408d073d81acebc8bc76faa303be7de7d0067343625bc2fcc9869aea';
const TUSHARE_URL = 'https://t.xiaodefa.top/';

const stockMap = {
  '振华科技': '000733.SZ', '000733': '000733.SZ',
  '立讯精密': '002475.SZ', '002475': '002475.SZ',
  '振华股份': '600267.SH', '600267': '600267.SH',
  '金牛化工': '600722.SH', '600722': '600722.SH',
  '贵州茅台': '600519.SH', '600519': '600519.SH',
  '宁德时代': '300750.SZ', '300750': '300750.SZ',
  '比亚迪': '002594.SZ', '002594': '002594.SZ',
  '中国平安': '601318.SH', '601318': '601318.SH',
};

const stockNameMap = {
  '000733': '振华科技', '002475': '立讯精密', '600267': '振华股份',
  '600722': '金牛化工', '600519': '贵州茅台', '300750': '宁德时代',
  '002594': '比亚迪', '601318': '中国平安',
};

app.get('/api/health', (req, res) => {
  res.json({ code: 0, msg: 'ok', data: { status: 'running', service: '稻谷查查1.0' } });
});

// 统计分析接口
app.post('/api/statAnalyze', async (req, res) => {
  const { stock_code, days = 120 } = req.body;
  if (!stock_code) {
    return res.json({ code: 400, msg: '缺少stock_code参数' });
  }

  try {
    let thscode = stock_code;
    let stockName = stockNameMap[stock_code] || stock_code;

    if (/^\d{6}$/.test(stock_code)) {
      const szPrefixes = ['000', '002', '300'];
      thscode = szPrefixes.includes(stock_code.slice(0, 3)) ? `${stock_code}.SZ` : `${stock_code}.SH`;
      // 数字代码也要查公司名称
      const searchResult = await searchStock(stock_code);
      if (searchResult) {
        stockName = searchResult.name;
      }
    } else if (!stock_code.includes('.')) {
      // 先尝试本地映射
      const localMap = stockMap[stock_code];
      if (localMap) {
        thscode = localMap;
      } else {
        // 本地没有则动态搜索
        const searchResult = await searchStock(stock_code);
        if (searchResult) {
          thscode = searchResult.ts_code;
          stockName = searchResult.name;
        }
      }
    }

    if (!thscode) {
      return res.json({ code: 404, msg: '无法识别股票代码' });
    }

    const today = new Date();
    const endDate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
    // 尝试最近1年，如果数据不足则逐步扩展到2年、3年
    let klineData = null;
    for (const years of [1, 2, 3]) {
      const startDate = `${today.getFullYear() - years}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
      klineData = await fetchKline(thscode, startDate, endDate);
      if (klineData && klineData.length > 10) break;
    }
    if (!klineData || klineData.length === 0) {
      return res.json({ code: 404, msg: '获取K线数据失败，可能已停牌或退市' });
    }

    // 排序（按日期升序）
    klineData.sort((a, b) => a.trade_date.localeCompare(b.trade_date));

    // 参与分析的120个交易日的起止日期
    const analysisStartDate = klineData[klineData.length - n].trade_date;
    const analysisEndDate = klineData[klineData.length - 1].trade_date;

    // 计算指标
    const closes = klineData.map(d => parseFloat(d.close));
    const vols = klineData.map(d => parseFloat(d.vol));
    const pctChgs = klineData.map(d => parseFloat(d.pct_chg));
    const amounts = klineData.map(d => parseFloat(d.amount));
    const dates = klineData.map(d => d.trade_date);

    function ma(arr, n) {
      return arr.map((_, i) => {
        if (i < n - 1) return null;
        return arr.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
      });
    }

    const ma5 = ma(closes, 5);
    const ma10 = ma(closes, 10);
    const ma20 = ma(closes, 20);
    const ma60 = ma(closes, 60);
    const vMa5 = ma(vols, 5);
    const volRatios = vols.map((v, i) => vMa5[i] ? v / vMa5[i] : 1);

    // 估算换手率（成交额/市值）
    const lastClose = closes[closes.length - 1];
    const floatShares = lastClose * closes.length * 1000;
    const turnoverRate = amounts.map((a, i) => a * 10000 / closes[i] / (floatShares || 1) * 100);

    // 取近days个交易日
    const n = Math.min(parseInt(days), klineData.length - 1);
    const lastN = klineData.slice(-n);
    const startIdx = klineData.length - n;

    // 同时收集红盘样本和绿盘样本
    const redSamples = [];
    const greenSamples = [];
    for (let i = 0; i < lastN.length - 1; i++) {
      const idx = startIdx + i;
      const nextPct = pctChgs[idx + 1];
      const sample = {
        date: dates[idx],
        today_pct: pctChgs[idx],
        volRatio: volRatios[idx],
        turnoverRate: turnoverRate[idx],
        vsMa5: ma5[idx] ? (closes[idx] - ma5[idx]) / ma5[idx] * 100 : 0,
        vsMa10: ma10[idx] ? (closes[idx] - ma10[idx]) / ma10[idx] * 100 : 0,
        vsMa20: ma20[idx] ? (closes[idx] - ma20[idx]) / ma20[idx] * 100 : 0,
        vsMa60: ma60[idx] ? (closes[idx] - ma60[idx]) / ma60[idx] * 100 : 0,
        next_pct: nextPct
      };
      if (nextPct > 0) redSamples.push(sample);
      else if (nextPct < 0) greenSamples.push(sample);
    }

    const totalRed = redSamples.length;
    const totalGreen = greenSamples.length;
    const totalAll = totalRed + totalGreen;

    // 合并统计函数：同一label下并排红盘和绿盘
    function mergeStatBy(redArr, greenArr, bins) {
      const map = {};
      redArr.forEach(s => {
        const k = bins(s);
        if (!map[k]) map[k] = { label: k, red_count: 0, red_sum: 0, green_count: 0, green_sum: 0 };
        map[k].red_count++;
        map[k].red_sum += s.next_pct;
      });
      greenArr.forEach(s => {
        const k = bins(s);
        if (!map[k]) map[k] = { label: k, red_count: 0, red_sum: 0, green_count: 0, green_sum: 0 };
        map[k].green_count++;
        map[k].green_sum += s.next_pct;
      });
      return Object.entries(map).map(([k, v]) => ({
        label: v.label,
        red_count: v.red_count,
        red_avg: v.red_count ? (v.red_sum / v.red_count).toFixed(2) : '0.00',
        green_count: v.green_count,
        green_avg: v.green_count ? (v.green_sum / v.green_count).toFixed(2) : '0.00',
      }));
    }

    // 标记最优（红盘均涨幅最高的行）
    function markBestMerged(rows) {
      const valid = rows.filter(x => x.red_count >= 2);
      if (valid.length === 0) return rows;
      const maxRedAvg = Math.max(...valid.map(x => parseFloat(x.red_avg)));
      return rows.map(x => ({
        ...x,
        isBest: x.red_count >= 2 && parseFloat(x.red_avg) === maxRedAvg
      }));
    }

    // 1. 量比分层
    const volRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.volRatio < 0.7) return '缩量(<0.7)';
      if (s.volRatio < 1.2) return '正常(0.7-1.2)';
      if (s.volRatio < 2.0) return '放量(1.2-2.0)';
      return '巨量(>2.0)';
    });
    const volStats = markBestMerged(volRows);

    // 2. MA5分层
    const ma5Rows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.vsMa5 > 5) return '股价在5日线上方远离';
      if (s.vsMa5 > 0) return '股价在5日线上方';
      if (s.vsMa5 > -5) return '股价在5日线下方';
      return '股价在5日线下方远离';
    });
    const ma5Stats = markBestMerged(ma5Rows);

    // 3. MA20分层
    const ma20Rows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.vsMa20 > 10) return '股价在20日线上方远离';
      if (s.vsMa20 > 0) return '股价在20日线上方';
      if (s.vsMa20 > -10) return '股价在20日线下方';
      return '股价在20日线下方远离';
    });
    const ma20Stats = markBestMerged(ma20Rows);

    // 4. 换手率分层
    const turnRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.turnoverRate < 1) return '低换(<1%)';
      if (s.turnoverRate <= 3) return '正常(1-3%)';
      if (s.turnoverRate <= 6) return '高换(3-6%)';
      return '巨量换手(>6%)';
    });
    const turnStats = markBestMerged(turnRows);

    // 5. 前日涨跌幅分布
    const distRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.today_pct > 5) return '>5%';
      if (s.today_pct > 3) return '3~5%';
      if (s.today_pct > 1) return '1~3%';
      if (s.today_pct > 0) return '0~1%';
      if (s.today_pct > -1) return '-1~0%';
      if (s.today_pct > -3) return '-3~-1%';
      if (s.today_pct > -5) return '-5~-3%';
      return '<-5%';
    });
    const distStats = markBestMerged(distRows);

    // 6. 综合条件
    function makeCondStat(redArr, greenArr, filterFn, label) {
      const r = redArr.filter(filterFn);
      const g = greenArr.filter(filterFn);
      return {
        label,
        red_count: r.length,
        red_avg: r.length ? (r.reduce((s,x)=>s+x.next_pct,0)/r.length).toFixed(2) : '0.00',
        green_count: g.length,
        green_avg: g.length ? (g.reduce((s,x)=>s+x.next_pct,0)/g.length).toFixed(2) : '0.00',
      };
    }
    const condStatsRaw = [
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.volRatio < 1 && s.vsMa5 < 0, '前一天跌超3% + 缩量 + 股价在5日线下方'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -5 && s.volRatio < 0.8, '前一天跌超5% + 极度缩量'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.vsMa5 < -3, '前一天跌超3% + 股价偏离5日线3%以上'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.vsMa20 < -5, '前一天跌超3% + 股价偏离20日线5%以上'),
    ];
    const condStats = markBestMerged(condStatsRaw);

    // 生成结论
    const bestVol = volStats.find(x => x.isBest);
    const bestMa5 = ma5Stats.find(x => x.isBest);
    const bestMa20 = ma20Stats.find(x => x.isBest);
    const bestDist = distStats.find(x => x.isBest);
    const bestCond = condStats.find(x => x.isBest);

    const conclusions = {
      vol: `成交量最好的情况：${bestVol ? bestVol.label : 'N/A'}（红盘均涨${bestVol ? bestVol.red_avg : '0'}%，绿盘均跌${bestVol ? bestVol.green_avg : '0'}%）`,
      ma5: `5日均线最佳位置：${bestMa5 ? bestMa5.label : 'N/A'}（红盘均涨${bestMa5 ? bestMa5.red_avg : '0'}%，绿盘均跌${bestMa5 ? bestMa5.green_avg : '0'}%）`,
      ma20: `20日均线最佳位置：${bestMa20 ? bestMa20.label : 'N/A'}（红盘均涨${bestMa20 ? bestMa20.red_avg : '0'}%，绿盘均跌${bestMa20 ? bestMa20.green_avg : '0'}%）`,
      dist: `前日涨跌最佳区间：${bestDist ? bestDist.label : 'N/A'}（红盘均涨${bestDist ? bestDist.red_avg : '0'}%，绿盘均跌${bestDist ? bestDist.green_avg : '0'}%）`,
      cond: `最优买入条件：${bestCond ? bestCond.label : 'N/A'}（红盘均涨${bestCond ? bestCond.red_avg : '0'}%，绿盘均跌${bestCond ? bestCond.green_avg : '0'}%）`,
      overall: `综合来看，${bestCond ? bestCond.label : 'N/A'}时红盘概率和涨幅最好（均涨${bestCond ? bestCond.red_avg : '0'}%）。量能选${bestVol ? bestVol.label : ''}、股价在5日线${bestMa5 ? bestMa5.label.replace('股价在5日线', '') : ''}时胜率更高。`
    };

    // Top10红盘样本
    const top10 = [...redSamples].sort((a, b) => b.next_pct - a.next_pct).slice(0, 10);

    // 检查数据是否太老（超过30个自然日无新数据）
    const lastTradeDate = analysisEndDate;
    const lastTradeTs = new Date(lastTradeDate.slice(0,4), parseInt(lastTradeDate.slice(4,6))-1, lastTradeDate.slice(6,8)).getTime();
    const todayTs = new Date().getTime();
    const daysSinceLastTrade = Math.floor((todayTs - lastTradeTs) / 86400000);
    const dataIsStale = daysSinceLastTrade > 30;

    res.json({
      code: 0,
      data: {
        stock_code: thscode,
        stock_name: stockName,
        days: n,
        data_start_date: `${analysisStartDate.slice(0,4)}-${analysisStartDate.slice(4,6)}-${analysisStartDate.slice(6,8)}`,
        data_end_date: `${analysisEndDate.slice(0,4)}-${analysisEndDate.slice(4,6)}-${analysisEndDate.slice(6,8)}`,
        data_is_stale: dataIsStale,
        data_stale_days: dataIsStale ? daysSinceLastTrade : 0,
        total_red: totalRed,
        total_green: totalGreen,
        vol_stats: volStats,
        ma5_stats: ma5Stats,
        ma20_stats: ma20Stats,
        turn_stats: turnStats,
        dist_stats: distStats,
        cond_stats: condStats,
        conclusions: conclusions,
        top10: top10.map(s => ({
          date: s.date,
          today_pct: s.today_pct.toFixed(2),
          next_pct: s.next_pct.toFixed(2),
          vol_ratio: s.volRatio.toFixed(2),
          vs_ma5: s.vsMa5.toFixed(1),
          vs_ma20: s.vsMa20.toFixed(1),
          turnover: s.turnoverRate.toFixed(1)
        }))
      }
    });

  } catch (err) {
    console.error('统计分析出错:', err.message);
    res.json({ code: 500, msg: `服务器错误: ${err.message}` });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { stock_code } = req.body;
  if (!stock_code) {
    return res.json({ code: 400, msg: '缺少stock_code参数' });
  }

  try {
    let thscode = stock_code;
    if (/^\d{6}$/.test(stock_code)) {
      const szPrefixes = ['000', '002', '300'];
      thscode = szPrefixes.includes(stock_code.slice(0, 3)) ? `${stock_code}.SZ` : `${stock_code}.SH`;
    } else if (!stock_code.includes('.')) {
      thscode = stockMap[stock_code] || null;
    }

    if (!thscode) {
      return res.json({ code: 404, msg: '无法识别股票代码' });
    }

    const today = new Date();
    const endDate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

    const klineData = await fetchKline(thscode, '20250101', endDate);
    if (!klineData || klineData.length === 0) {
      return res.json({ code: 404, msg: '获取K线数据失败，可能停牌或代码错误' });
    }

    const report = await analyze(thscode);
    if (report.error) {
      return res.json({ code: 500, msg: report.error });
    }

    res.json({ code: 0, data: report });

  } catch (err) {
    console.error('出错:', err.message);
    res.json({ code: 500, msg: `服务器错误: ${err.message}` });
  }
});

async function fetchKline(thscode, startDate, endDate) {
  const payload = {
    api_name: 'daily',
    token: TUSHARE_TOKEN,
    params: { ts_code: thscode, start_date: startDate, end_date: endDate }
  };

  try {
    const resp = await fetch(TUSHARE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (result.code !== 0) return null;
    const fields = result.data.fields;
    const items = result.data.items;
    return items.map(row => {
      const obj = {};
      fields.forEach((f, i) => obj[f] = row[i]);
      return obj;
    });
  } catch {
    return null;
  }
}

async function searchStock(keyword) {
  // 判断是数字代码还是名称
  if (/^\d{6}$/.test(keyword)) {
    const szPrefixes = ['000', '002', '300'];
    const ts_code = szPrefixes.includes(keyword.slice(0, 3)) ? `${keyword}.SZ` : `${keyword}.SH`;
    // 用 ts_code 精确查询获取公司名称
    const payload = {
      api_name: 'stock_basic',
      token: TUSHARE_TOKEN,
      params: { ts_code: ts_code, name: '', list_status: 'L' }
    };
    try {
      const resp = await fetch(TUSHARE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await resp.json();
      if (result.code === 0 && result.data && result.data.items && result.data.items.length > 0) {
        const item = result.data.items[0];
        return { ts_code: item[0], name: item[2] };
      }
    } catch { /* fall through */ }
  }
  // 名称模糊搜索
  const payload = {
    api_name: 'stock_basic',
    token: TUSHARE_TOKEN,
    params: { ts_code: '', name: keyword, list_status: 'L' }
  };
  try {
    const resp = await fetch(TUSHARE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (result.code === 0 && result.data && result.data.items && result.data.items.length > 0) {
      const item = result.data.items[0];
      return { ts_code: item[0], name: item[2] };
    }
  } catch {
    return null;
  }
  return null;
}

app.listen(PORT, () => {
  console.log(`稻谷查查1.0 运行在 http://localhost:${PORT}`);
});
