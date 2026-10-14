const https = require('https');
const TUSHARE_TOKEN = '408d073d81acebc8bc76faa303be7de7d0067343625bc2fcc9869aea';
const TUSHARE_URL = 'https://t.xiaodefa.top/';
const today = new Date();
const endDate = today.getFullYear() + String(today.getMonth()+1).padStart(2,'0') + String(today.getDate()).padStart(2,'0');

async function callApi(apiName, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ api_name: apiName, token: TUSHARE_TOKEN, params });
    const req = https.request(TUSHARE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function ma(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    return arr.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  });
}

callApi('daily', { ts_code: '002172.SZ', start_date: '20241201', end_date: endDate })
  .then(r => {
    if (r.code !== 0) { console.log('Error:', r.msg); return; }
    const fields = r.data.fields;
    const items = r.data.items.map(row => {
      const obj = {};
      fields.forEach((f, i) => obj[f] = row[i]);
      return obj;
    });
    items.sort((a, b) => a.trade_date.localeCompare(b.trade_date));

    const closes = items.map(d => parseFloat(d.close));
    const vols = items.map(d => parseFloat(d.vol));
    const pctChgs = items.map(d => parseFloat(d.pct_chg));
    const amounts = items.map(d => parseFloat(d.amount));
    const dates = items.map(d => d.trade_date);

    const ma5 = ma(closes, 5);
    const ma10 = ma(closes, 10);
    const ma20 = ma(closes, 20);
    const ma60 = ma(closes, 60);
    const vMa5 = ma(vols, 5);
    const volRatios = vols.map((v, i) => vMa5[i] ? v / vMa5[i] : 1);
    const floatShares = 1.2e8;
    const turnoverRate = amounts.map((a, i) => a * 10000 / closes[i] / floatShares * 100);

    const last120 = items.slice(-120);
    const startIdx = items.length - 120;

    const samples = [];
    for (let i = 0; i < last120.length - 1; i++) {
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

    console.log('=== 澳洋健康 次日红盘细化分析(近120交易日) ===');
    console.log('次日红盘样本:', samples.length);

    // 1. 量比分析
    console.log('\n【1. 按量比分层】');
    const volStats = {};
    samples.forEach(s => {
      let bin;
      if (s.volRatio < 0.7) bin = '缩量(<0.7)';
      else if (s.volRatio < 1.2) bin = '正常(0.7-1.2)';
      else if (s.volRatio < 2.0) bin = '放量(1.2-2.0)';
      else bin = '巨量(>2.0)';
      if (!volStats[bin]) volStats[bin] = {count:0, sum:0};
      volStats[bin].count++;
      volStats[bin].sum += s.next_pct;
    });
    Object.entries(volStats).forEach(([k, v]) => {
      console.log(k + ': ' + v.count + '次, 均涨幅' + (v.sum/v.count).toFixed(2) + '%');
    });

    // 2. MA5位置分析
    console.log('\n【2. 按收盘vs MA5分层】');
    const ma5Stats = {};
    samples.forEach(s => {
      let bin;
      if (s.vsMa5 > 5) bin = '远离上方(>5%)';
      else if (s.vsMa5 > 0) bin = '之上';
      else if (s.vsMa5 > -5) bin = '之下';
      else bin = '远离下方(<-5%)';
      if (!ma5Stats[bin]) ma5Stats[bin] = {count:0, sum:0};
      ma5Stats[bin].count++;
      ma5Stats[bin].sum += s.next_pct;
    });
    Object.entries(ma5Stats).forEach(([k, v]) => {
      console.log(k + ': ' + v.count + '次, 均涨幅' + (v.sum/v.count).toFixed(2) + '%');
    });

    // 3. MA20位置分析
    console.log('\n【3. 按收盘vs MA20分层】');
    const ma20Stats = {};
    samples.forEach(s => {
      let bin;
      if (s.vsMa20 > 10) bin = '远离上方(>10%)';
      else if (s.vsMa20 > 0) bin = '之上';
      else if (s.vsMa20 > -10) bin = '之下';
      else bin = '远离下方(<-10%)';
      if (!ma20Stats[bin]) ma20Stats[bin] = {count:0, sum:0};
      ma20Stats[bin].count++;
      ma20Stats[bin].sum += s.next_pct;
    });
    Object.entries(ma20Stats).forEach(([k, v]) => {
      console.log(k + ': ' + v.count + '次, 均涨幅' + (v.sum/v.count).toFixed(2) + '%');
    });

    // 4. 换手率分析
    console.log('\n【4. 按换手率分层】');
    const turnStats = {};
    samples.forEach(s => {
      let bin;
      if (s.turnoverRate < 1) bin = '低换(<1%)';
      else if (s.turnoverRate <= 3) bin = '正常(1-3%)';
      else if (s.turnoverRate <= 6) bin = '高换(3-6%)';
      else bin = '巨量换手(>6%)';
      if (!turnStats[bin]) turnStats[bin] = {count:0, sum:0};
      turnStats[bin].count++;
      turnStats[bin].sum += s.next_pct;
    });
    Object.entries(turnStats).forEach(([k, v]) => {
      console.log(k + ': ' + v.count + '次, 均涨幅' + (v.sum/v.count).toFixed(2) + '%');
    });

    // 5. 综合最优条件
    console.log('\n【5. 综合条件分析】');
    const cond1 = samples.filter(s => s.today_pct < -3 && s.volRatio < 1 && s.vsMa5 < 0);
    console.log('条件A 前日<-3% + 量比<1 + MA5下方: ' + cond1.length + '次, 均涨幅' + (cond1.length ? (cond1.reduce((s,x)=>s+x.next_pct,0)/cond1.length).toFixed(2) : 0) + '%');

    const cond2 = samples.filter(s => s.today_pct < -5 && s.volRatio < 0.8);
    console.log('条件B 前日<-5% + 量比<0.8: ' + cond2.length + '次, 均涨幅' + (cond2.length ? (cond2.reduce((s,x)=>s+x.next_pct,0)/cond2.length).toFixed(2) : 0) + '%');

    const cond3 = samples.filter(s => s.today_pct < -3 && s.vsMa5 < -3);
    console.log('条件C 前日<-3% + MA5偏离<-3%: ' + cond3.length + '次, 均涨幅' + (cond3.length ? (cond3.reduce((s,x)=>s+x.next_pct,0)/cond3.length).toFixed(2) : 0) + '%');

    const cond4 = samples.filter(s => s.today_pct < -3 && s.vsMa20 < -5);
    console.log('条件D 前日<-3% + MA20偏离<-5%: ' + cond4.length + '次, 均涨幅' + (cond4.length ? (cond4.reduce((s,x)=>s+x.next_pct,0)/cond4.length).toFixed(2) : 0) + '%');

    const cond5 = samples.filter(s => s.today_pct < -5 && s.turnoverRate < 3);
    console.log('条件E 前日<-5% + 换手率<3%: ' + cond5.length + '次, 均涨幅' + (cond5.length ? (cond5.reduce((s,x)=>s+x.next_pct,0)/cond5.length).toFixed(2) : 0) + '%');

    const cond6 = samples.filter(s => s.today_pct < -5 && s.volRatio < 0.8 && s.turnoverRate < 4);
    console.log('条件F 前日<-5% + 量比<0.8 + 换手<4%: ' + cond6.length + '次, 均涨幅' + (cond6.length ? (cond6.reduce((s,x)=>s+x.next_pct,0)/cond6.length).toFixed(2) : 0) + '%');

    // Top10样本
    console.log('\n【Top10次日涨幅样本】');
    const sorted = [...samples].sort((a, b) => b.next_pct - a.next_pct);
    sorted.slice(0, 10).forEach(s => {
      console.log(s.date + ' 今日' + s.today_pct.toFixed(2) + '% -> 明日' + s.next_pct.toFixed(2) + '% | 量比' + s.volRatio.toFixed(2) + ' MA5' + s.vsMa5.toFixed(1) + '% MA20' + s.vsMa20.toFixed(1) + '% 换手' + s.turnoverRate.toFixed(1) + '%');
    });

    // 前日涨幅分布
    console.log('\n【前日涨跌幅分布(次日红盘前一日)】');
    const distBins = {};
    samples.forEach(s => {
      let bin;
      if (s.today_pct > 5) bin = '>5%';
      else if (s.today_pct > 3) bin = '3~5%';
      else if (s.today_pct > 1) bin = '1~3%';
      else if (s.today_pct > 0) bin = '0~1%';
      else if (s.today_pct > -1) bin = '-1~0%';
      else if (s.today_pct > -3) bin = '-3~-1%';
      else if (s.today_pct > -5) bin = '-5~-3%';
      else bin = '<-5%';
      if (!distBins[bin]) distBins[bin] = {count:0, sum:0};
      distBins[bin].count++;
      distBins[bin].sum += s.next_pct;
    });
    const order = ['<-5%','-5~-3%','-3~-1%','-1~0%','0~1%','1~3%','3~5%','>5%'];
    order.forEach(k => {
      if (distBins[k]) console.log('前日' + k + ': ' + distBins[k].count + '次, 均涨幅' + (distBins[k].sum/distBins[k].count).toFixed(2) + '%');
    });
  }).catch(e => console.error(e));
