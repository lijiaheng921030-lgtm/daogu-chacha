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
    const startDate = `${today.getFullYear() - 1}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

    const klineData = await fetchKline(thscode, startDate, endDate);
    if (!klineData || klineData.length === 0) {
      return res.json({ code: 404, msg: '获取K线数据失败' });
    }

    // 排序
    klineData.sort((a, b) => a.trade_date.localeCompare(b.trade_date));

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

    // 次日红盘样本
    const samples = [];
    for (let i = 0; i < lastN.length - 1; i++) {
      const idx = startIdx + i;
      const next_red = pctChgs[idx + 1] > 0;
      if (next_red) {
        samples.push({
          date: dates[idx],
          today_pct: pctChgs[idx],
          volRatio: volRatios[idx],
          turnoverRate: turnoverRate[idx],
          vsMa5: ma5[idx] ? (closes[idx] - ma5[idx]) / ma5[idx] * 100 : 0,
          vsMa10: ma10[idx] ? (closes[idx] - ma10[idx]) / ma10[idx] * 100 : 0,
          vsMa20: ma20[idx] ? (closes[idx] - ma20[idx]) / ma20[idx] * 100 : 0,
          vsMa60: ma60[idx] ? (closes[idx] - ma60[idx]) / ma60[idx] * 100 : 0,
          next_pct: pctChgs[idx + 1]
        });
      }
    }

    // 统计函数
    function statBy(arr, bins) {
      const result = {};
      arr.forEach(s => {
        let bin = bins(s);
        if (!result[bin]) result[bin] = { count: 0, sum: 0 };
        result[bin].count++;
        result[bin].sum += s.next_pct;
      });
      return Object.entries(result).map(([k, v]) => ({ label: k, count: v.count, sum: v.sum, avg: v.count ? (v.sum / v.count) : 0 }));
    }

    // 添加isBest标记和占比 - 找出该分类中avg最高的项
    function markBest(arr, total) {
      const validItems = arr.filter(x => x.count >= 2);
      if (validItems.length === 0) return arr.map(x => ({ ...x, isBest: false, ratio: ((x.count / total) * 100).toFixed(1), avg: x.count ? (x.sum / x.count).toFixed(2) : '0.00' }));
      const maxAvg = Math.max(...validItems.map(x => x.avg));
      return arr.map(x => ({ ...x, isBest: x.avg === maxAvg && x.count >= 2, ratio: ((x.count / total) * 100).toFixed(1), avg: x.count ? (x.sum / x.count).toFixed(2) : '0.00' }));
    }

    // 1. 量比分层
    const volStats = markBest(statBy(samples, s => {
      if (s.volRatio < 0.7) return '缩量(<0.7)';
      if (s.volRatio < 1.2) return '正常(0.7-1.2)';
      if (s.volRatio < 2.0) return '放量(1.2-2.0)';
      return '巨量(>2.0)';
    }), samples.length);

    // 2. MA5分层
    const ma5Stats = markBest(statBy(samples, s => {
      if (s.vsMa5 > 5) return '股价在5日线上方远离';
      if (s.vsMa5 > 0) return '股价在5日线上方';
      if (s.vsMa5 > -5) return '股价在5日线下方';
      return '股价在5日线下方远离';
    }), samples.length);

    // 3. MA20分层
    const ma20Stats = markBest(statBy(samples, s => {
      if (s.vsMa20 > 10) return '股价在20日线上方远离';
      if (s.vsMa20 > 0) return '股价在20日线上方';
      if (s.vsMa20 > -10) return '股价在20日线下方';
      return '股价在20日线下方远离';
    }), samples.length);

    // 4. 换手率分层
    const turnStats = markBest(statBy(samples, s => {
      if (s.turnoverRate < 1) return '低换(<1%)';
      if (s.turnoverRate <= 3) return '正常(1-3%)';
      if (s.turnoverRate <= 6) return '高换(3-6%)';
      return '巨量换手(>6%)';
    }), samples.length);

    // 5. 综合条件
    const condA = samples.filter(s => s.today_pct < -3 && s.volRatio < 1 && s.vsMa5 < 0);
    const condB = samples.filter(s => s.today_pct < -5 && s.volRatio < 0.8);
    const condC = samples.filter(s => s.today_pct < -3 && s.vsMa5 < -3);
    const condD = samples.filter(s => s.today_pct < -3 && s.vsMa20 < -5);

    const condStats = [
      { label: '前一天跌超3% + 缩量 + 股价在5日线下方', count: condA.length, sum: condA.length ? condA.reduce((s,x)=>s+x.next_pct,0) : 0 },
      { label: '前一天跌超5% + 极度缩量', count: condB.length, sum: condB.length ? condB.reduce((s,x)=>s+x.next_pct,0) : 0 },
      { label: '前一天跌超3% + 股价偏离5日线3%以上', count: condC.length, sum: condC.length ? condC.reduce((s,x)=>s+x.next_pct,0) : 0 },
      { label: '前一天跌超3% + 股价偏离20日线5%以上', count: condD.length, sum: condD.length ? condD.reduce((s,x)=>s+x.next_pct,0) : 0 },
    ].map(x => ({ ...x, avg: x.count ? x.sum / x.count : 0 }));
    const markedCondStats = markBest(condStats, samples.length);

    // 6. 前日分布
    const distStats = markBest(statBy(samples, s => {
      if (s.today_pct > 5) return '>5%';
      if (s.today_pct > 3) return '3~5%';
      if (s.today_pct > 1) return '1~3%';
      if (s.today_pct > 0) return '0~1%';
      if (s.today_pct > -1) return '-1~0%';
      if (s.today_pct > -3) return '-3~-1%';
      if (s.today_pct > -5) return '-5~-3%';
      return '<-5%';
    }), samples.length);

    // 生成结论
    const bestVol = volStats.find(x => x.isBest);
    const bestMa5 = ma5Stats.find(x => x.isBest);
    const bestMa20 = ma20Stats.find(x => x.isBest);
    const bestDist = distStats.find(x => x.isBest);
    const bestCond = markedCondStats.find(x => x.isBest);

    const conclusions = {
      vol: `成交量最好的情况：${bestVol ? bestVol.label : 'N/A'}（${bestVol ? bestVol.avg : '0'}%次日平均涨幅）`,
      ma5: `5日均线最佳位置：${bestMa5 ? bestMa5.label : 'N/A'}（${bestMa5 ? bestMa5.avg : '0'}%次日平均涨幅）`,
      ma20: `20日均线最佳位置：${bestMa20 ? bestMa20.label : 'N/A'}（${bestMa20 ? bestMa20.avg : '0'}%次日平均涨幅）`,
      dist: `前日涨跌最佳区间：${bestDist ? bestDist.label : 'N/A'}（${bestDist ? bestDist.avg : '0'}%次日平均涨幅）`,
      cond: `最优买入条件：${bestCond ? bestCond.label : 'N/A'}（${bestCond ? bestCond.avg : '0'}%次日平均涨幅）`,
      overall: `综合来看，${bestCond ? bestCond.label : 'N/A'}这种情况下，次日上涨概率和涨幅最可观。配合量能${bestVol ? bestVol.label : ''}、股价在5日线${bestMa5 ? bestMa5.label.replace('股价在5日线', '') : ''}时效果更好。`
    };

    // Top10
    const top10 = [...samples].sort((a, b) => b.next_pct - a.next_pct).slice(0, 10);

    res.json({
      code: 0,
      data: {
        stock_code: thscode,
        stock_name: stockName,
        days: n,
        total_samples: samples.length,
        vol_stats: volStats,
        ma5_stats: ma5Stats,
        ma20_stats: ma20Stats,
        turn_stats: turnStats,
        dist_stats: distStats,
        cond_stats: markedCondStats,
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
