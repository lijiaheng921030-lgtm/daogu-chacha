const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || '42f7594e9640ff73a5b018a021a4141ab9012c37d6e6d599bb6221eb';
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

    const csvPath = path.join(__dirname, 'temp_kline.csv');
    writeKlineToCSV(klineData, csvPath);

    // 直接调用backtest.py，传入ts_code和csv_path
    const backtestPy = path.join(__dirname, 'backtest.py');
    const result = execSync(`py -3 "${backtestPy}" "${thscode}" "${csvPath}"`, {
      encoding: 'utf-8',
      timeout: 60000,
      cwd: __dirname,
    });

    const report = JSON.parse(result);
    const codeNum = thscode.split('.')[0];
    report.stock_code = thscode;
    report.stock_name = stockNameMap[codeNum] || codeNum;

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
