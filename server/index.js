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

// 调试搜索接口
app.get('/api/debug-search', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.json({ code: 400, msg: '缺少keyword参数' });
  try {
    const result = await searchStock(keyword);
    res.json({ code: 0, data: result });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
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
    const floatShares = lastClose * closes.length * 1000; // 粗略估算
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
      return Object.entries(result).map(([k, v]) => ({ label: k, count: v.count, avg: v.count ? (v.sum / v.count) : 0 }));
    }

    // 1. 量比分层
    const volStats = statBy(samples, s => {
      if (s.volRatio < 0.7) return '缩量(<0.7)';
      if (s.volRatio < 1.2) return '正常(0.7-1.2)';
      if (s.volRatio < 2.0) return '放量(1.2-2.0)';
      return '巨量(>2.0)';
    });

    // 2. MA5分层
    const ma5Stats = statBy(samples, s => {
      if (s.vsMa5 > 5) return '远离上方(>5%)';
      if (s.vsMa5 > 0) return '之上';
      if (s.vsMa5 > -5) return '之下';
      return '远离下方(<-5%)';
    });

    // 3. MA20分层
    const ma20Stats = statBy(samples, s => {
      if (s.vsMa20 > 10) return '远离上方(>10%)';
      if (s.vsMa20 > 0) return '之上';
      if (s.vsMa20 > -10) return '之下';
      return '远离下方(<-10%)';
    });

    // 4. 换手率分层
    const turnStats = statBy(samples, s => {
      if (s.turnoverRate < 1) return '低换(<1%)';
      if (s.turnoverRate <= 3) return '正常(1-3%)';
      if (s.turnoverRate <= 6) return '高换(3-6%)';
      return '巨量换手(>6%)';
    });

    // 5. 综合条件
    const condA = samples.filter(s => s.today_pct < -3 && s.volRatio < 1 && s.vsMa5 < 0);
    const condB = samples.filter(s => s.today_pct < -5 && s.volRatio < 0.8);
    const condC = samples.filter(s => s.today_pct < -3 && s.vsMa5 < -3);
    const condD = samples.filter(s => s.today_pct < -3 && s.vsMa20 < -5);

    // 6. 前日分布
    const distStats = statBy(samples, s => {
      if (s.today_pct > 5) return '>5%';
      if (s.today_pct > 3) return '3~5%';
      if (s.today_pct > 1) return '1~3%';
      if (s.today_pct > 0) return '0~1%';
      if (s.today_pct > -1) return '-1~0%';
      if (s.today_pct > -3) return '-3~-1%';
      if (s.today_pct > -5) return '-5~-3%';
      return '<-5%';
    });

    // Top10
    const top10 = [...samples].sort((a, b) => b.next_pct - a.next_pct).slice(0, 10);

    res.json({
      code: 0,
      data: {
        stock_code: thscode,
        stock_name: stockName,
        days: n,
        total_samples: samples.length,
        // 统计分析
        vol_stats: volStats,
        ma5_stats: ma5Stats,
        ma20_stats: ma20Stats,
        turn_stats: turnStats,
        dist_stats: distStats,
        cond_stats: [
          { label: '前日<-3% + 量比<1 + MA5下方', count: condA.length, avg: condA.length ? condA.reduce((s,x)=>s+x.next_pct,0)/condA.length : 0 },
          { label: '前日<-5% + 量比<0.8', count: condB.length, avg: condB.length ? condB.reduce((s,x)=>s+x.next_pct,0)/condB.length : 0 },
          { label: '前日<-3% + MA5偏离<-3%', count: condC.length, avg: condC.length ? condC.reduce((s,x)=>s+x.next_pct,0)/condC.length : 0 },
          { label: '前日<-3% + MA20偏离<-5%', count: condD.length, avg: condD.length ? condD.reduce((s,x)=>s+x.next_pct,0)/condD.length : 0 },
        ],
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

    // 调用JS版回测（无需Python）
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

// 搜索股票代码
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
      return { ts_code: item[0], name: item[2] }; // ts_code, name
    }
  } catch {
    return null;
  }
  return null;
}

function writeKlineToCSV(data, csvPath) {
  if (data.length === 0) return;
  const fields = Object.keys(data[0]);
  const lines = [fields.join(',')];
  data.forEach(row => {
    lines.push(fields.map(f => row[f] ?? '').join(','));
  });
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf-8');
}

app.listen(PORT, () => {
  console.log(`稻谷查查1.0 运行在 http://localhost:${PORT}`);
});
