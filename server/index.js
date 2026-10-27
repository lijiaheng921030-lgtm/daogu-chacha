const express = require('express');
const cors = require('cors');
const { analyze } = require('./backtest.js');
const path = require('path');
const fs = require('fs');
const {
  fetchKline, fetchDailyBasic, fetchAuction, fetchMoneyflow, byDate, searchStock,
} = require('./tushare.js');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

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
    // 中文名没查到对应代码 → 明确报错，不要拿名字去查K线（会误报"停牌"）
    if (!/^\d{6}\.(SZ|SH|BJ)$/.test(thscode)) {
      return res.json({ code: 404, msg: `未能查到「${stock_code}」对应的股票代码，请确认名称或直接输入6位数字代码` });
    }

    const today = new Date();
    const endDate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
    // 尝试最近1年，如果数据不足则逐步扩展到2年、3年
    let klineData = null;
    let basicData = [];
    let auctionData = [];
    let moneyflowData = [];
    for (const years of [1, 2, 3]) {
      const startDate = `${today.getFullYear() - years}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
      klineData = await fetchKline(thscode, startDate, endDate);
      if (klineData && klineData.length > 10) {
        // 分时走势所需的辅助数据（失败不阻断主流程）
        basicData = await fetchDailyBasic(thscode, startDate, endDate);
        auctionData = await fetchAuction(thscode, startDate, endDate);
        moneyflowData = await fetchMoneyflow(thscode, startDate, endDate);
        break;
      }
    }
    if (!klineData || klineData.length === 0) {
      return res.json({ code: 404, msg: '获取K线数据失败，可能已停牌或退市，或数据源暂时限流，请稍后重试' });
    }

    // 按日期索引辅助数据（停牌/节假日会导致日期不匹配，用日期对齐而非下标对齐）
    const basicMap = byDate(basicData);
    const auctionMap = byDate(auctionData);
    const moneyflowMap = byDate(moneyflowData);

    // 排序（按日期升序）
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

    // 参与分析的n个交易日的起止日期
    const analysisStartDate = klineData[startIdx].trade_date;
    const analysisEndDate = klineData[klineData.length - 1].trade_date;

    // 同时收集红盘样本和绿盘样本
    const redSamples = [];
    const greenSamples = [];
    for (let i = 0; i < lastN.length - 1; i++) {
      const idx = startIdx + i;
      const nextPct = pctChgs[idx + 1];
      const row = klineData[idx];

      // ---- 分时走势相关指标 ----
      // 1) 当日均价线（VWAP）：Tushare amount 单位为千元，vol 单位为手
      //    均价 = amount*1000 / (vol*100) = amount*10 / vol
      const amt = parseFloat(row.amount);
      const volHands = parseFloat(row.vol);
      const vwap = (amt && volHands && volHands > 0) ? (amt * 10 / volHands) : null;
      const close = closes[idx];
      // 收盘价相对当日均价线的偏离（%）：负数 = 收盘价在均价线下方（尾盘偏弱）
      const vwapDiff = vwap ? (close - vwap) / vwap * 100 : null;

      // 2) 收盘价在当日最高/最低价区间中的位置（%）：低 = 收盘在当日低位
      const high = parseFloat(row.high);
      const low = parseFloat(row.low);
      const closePos = (high > low) ? (close - low) / (high - low) * 100 : null;

      // 3) 下影线占最低价比例（%）：长下影 = 盘中大幅杀跌后被拉回
      const lowShadow = (low && low > 0) ? (Math.min(close, parseFloat(row.open)) - low) / low * 100 : null;

      // 4) 集合竞价（真实盘口数据）
      const auc = auctionMap[row.trade_date];
      let aucRatio = null, aucGap = null;
      if (auc) {
        // 竞价量 / 前5日平均成交量
        let sum5 = 0, c5 = 0;
        for (let j = Math.max(0, idx - 5); j < idx; j++) {
          sum5 += parseFloat(klineData[j].vol); c5++;
        }
        const avg5 = c5 ? sum5 / c5 : 0;
        if (avg5 > 0 && auc.vol != null) aucRatio = parseFloat(auc.vol) / avg5;
        // 竞价价相对前收的涨跌幅
        if (auc.price != null && auc.pre_close) {
          aucGap = (parseFloat(auc.price) - parseFloat(auc.pre_close)) / parseFloat(auc.pre_close) * 100;
        }
      }

      // 5) 真实换手率与真实量比（来自 daily_basic）
      const basic = basicMap[row.trade_date];
      const realTurnover = basic && basic.turnover_rate != null ? parseFloat(basic.turnover_rate) : null;
      const realVolRatio = basic && basic.volume_ratio != null ? parseFloat(basic.volume_ratio) : null;

      const sample = {
        date: dates[idx],
        today_pct: pctChgs[idx],
        volRatio: realVolRatio != null ? realVolRatio : volRatios[idx],
        turnoverRate: realTurnover != null ? realTurnover : turnoverRate[idx],
        vsMa5: ma5[idx] ? (closes[idx] - ma5[idx]) / ma5[idx] * 100 : 0,
        vsMa10: ma10[idx] ? (closes[idx] - ma10[idx]) / ma10[idx] * 100 : 0,
        vsMa20: ma20[idx] ? (closes[idx] - ma20[idx]) / ma20[idx] * 100 : 0,
        vsMa60: ma60[idx] ? (closes[idx] - ma60[idx]) / ma60[idx] * 100 : 0,
        // 分时走势
        vwapDiff: vwapDiff,
        closePos: closePos,
        lowShadow: lowShadow,
        aucRatio: aucRatio,
        aucGap: aucGap,
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
      const total = totalRed + totalGreen;
      return Object.entries(map).map(([k, v]) => ({
        label: v.label,
        red_count: v.red_count,
        red_ratio: ((v.red_count / total) * 100).toFixed(1),
        red_avg: v.red_count ? (v.red_sum / v.red_count).toFixed(2) : '0.00',
        green_count: v.green_count,
        green_ratio: ((v.green_count / total) * 100).toFixed(1),
        green_avg: v.green_count ? (v.green_sum / v.green_count).toFixed(2) : '0.00',
        sample_count: v.red_count + v.green_count,
        // 层内红盘率 = 该层红盘次数 / 该层总次数，即真正的"成功率"
        layer_rate: ((v.red_count + v.green_count) > 0
          ? (v.red_count / (v.red_count + v.green_count) * 100).toFixed(1) : '0.0'),
      }));
    }

    // 过滤掉样本过少的分层（少于3次的层没有统计意义，会误导用户）
    function dropSparse(rows, minCount = 3) {
      return rows.filter(r => r.sample_count >= minCount);
    }

    // 标记两个最优：成功率最高（红盘占比）、涨幅最高（红盘均涨）
    function markBestMerged(rows) {
      const valid = rows.filter(x => x.red_count >= 2);
      if (valid.length === 0) return rows.map(x => ({ ...x, isBestRatio: false, isBestAvg: false }));
      // "成功率" = 该层内红盘次数 / 该层总次数（不是占全样本的比例）
      const layerRate = x => {
        const c = x.red_count + x.green_count;
        return c > 0 ? x.red_count / c : 0;
      };
      const maxRedRatio = Math.max(...valid.map(layerRate));
      const maxRedAvg = Math.max(...valid.map(x => parseFloat(x.red_avg)));
      return rows.map(x => ({
        ...x,
        isBestRatio: x.red_count >= 2 && layerRate(x) === maxRedRatio,
        isBestAvg: x.red_count >= 2 && parseFloat(x.red_avg) === maxRedAvg,
      }));
    }

    // 1. 量比分层
    const volRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.volRatio < 0.7) return '缩量(<0.7)';
      if (s.volRatio < 1.2) return '正常(0.7-1.2)';
      if (s.volRatio < 2.0) return '放量(1.2-2.0)';
      return '巨量(>2.0)';
    });
    const volStats = markBestMerged(dropSparse(volRows));

    // 2. MA5分层（偏离5日线百分比）
    const ma5Rows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.vsMa5 > 5) return '股价在5日线上方（偏离>5%）';
      if (s.vsMa5 > 0) return '股价在5日线上方（0~5%）';
      if (s.vsMa5 > -5) return '股价在5日线下方（0~-5%）';
      return '股价在5日线下方（偏离<-5%）';
    });
    const ma5Stats = markBestMerged(dropSparse(ma5Rows));

    // 3. MA20分层（偏离20日线百分比）
    const ma20Rows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.vsMa20 > 10) return '股价在20日线上方（偏离>10%）';
      if (s.vsMa20 > 0) return '股价在20日线上方（0~10%）';
      if (s.vsMa20 > -10) return '股价在20日线下方（0~-10%）';
      return '股价在20日线下方（偏离<-10%）';
    });
    const ma20Stats = markBestMerged(dropSparse(ma20Rows));

    // 4. 换手率分层
    const turnRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.turnoverRate < 1) return '低换(<1%)';
      if (s.turnoverRate <= 3) return '正常(1-3%)';
      if (s.turnoverRate <= 6) return '高换(3-6%)';
      return '巨量换手(>6%)';
    });
    const turnStats = markBestMerged(dropSparse(turnRows));

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
    const distStats = markBestMerged(dropSparse(distRows));

    // ===== 分时走势维度 =====
    // 说明：Tushare 无分钟级权限，拿不到真正的分时均线走势。
    // 这里用"当日均价线（VWAP）+ 日内K线形态 + 集合竞价盘口"作为分时走势的代理指标。
    // 各分层的阈值来自 10 只股票 × 3335 个样本的跨股一致性检验 + bootstrap 稳健性检验。

    // 6. 收盘价 vs 当日均价线（分时均价线）
    const vwapRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.vwapDiff == null) return '当日均价数据缺失';
      if (s.vwapDiff > 0.5) return '收盘价高于当日均价线0.5%以上';
      if (s.vwapDiff < -0.5) return '收盘价低于当日均价线0.5%以上';
      return '收盘价贴近当日均价线(±0.5%)';
    });
    const vwapStats = markBestMerged(dropSparse(vwapRows));

    // 7. 日内K线形态（收盘位置 + 下影线）
    const shapeRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.closePos == null) return '日内高低点数据缺失';
      const longLower = s.lowShadow != null && s.lowShadow > 2;
      if (longLower) return '盘中杀跌后拉回（长下影线>2%）';
      if (s.closePos > 70) return '收盘在当日高位（>70%）';
      if (s.closePos < 30) return '收盘在当日低位（<30%）';
      return '收盘在当日中部（30~70%）';
    });
    const shapeStats = markBestMerged(dropSparse(shapeRows));

    // 8. 集合竞价强弱（真实盘口数据）
    const aucRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.aucRatio == null) return '集合竞价数据缺失';
      if (s.aucRatio > 0.5) return '竞价放量（>近5日均量0.5倍）';
      if (s.aucRatio > 0.1) return '竞价常量（0.1~0.5倍）';
      return '竞价极度缩量（<近5日均量0.1倍）';
    });
    const aucStats = markBestMerged(dropSparse(aucRows));

    // 9. 综合条件
    function makeCondStat(redArr, greenArr, filterFn, label) {
      const r = redArr.filter(filterFn);
      const g = greenArr.filter(filterFn);
      const total = totalRed + totalGreen;
      return {
        label,
        red_count: r.length,
        red_ratio: ((r.length / total) * 100).toFixed(1),
        red_avg: r.length ? (r.reduce((s,x)=>s+x.next_pct,0)/r.length).toFixed(2) : '0.00',
        green_count: g.length,
        green_ratio: ((g.length / total) * 100).toFixed(1),
        green_avg: g.length ? (g.reduce((s,x)=>s+x.next_pct,0)/g.length).toFixed(2) : '0.00',
        sample_count: r.length + g.length,
        layer_rate: ((r.length + g.length) > 0
          ? (r.length / (r.length + g.length) * 100).toFixed(1) : '0.0'),
      };
    }
    const condStatsRaw = [
      // —— 含分时走势的综合条件（跨10只股票×3335样本检验通过，层内红盘率56.2%，p=0.0015）——
      makeCondStat(redSamples, greenSamples,
        s => s.vwapDiff != null && s.vwapDiff < -0.5 && s.volRatio < 1 && s.vsMa5 < 0,
        '收盘价跌破当日均价线 + 缩量 + 股价在5日线下方'),
      makeCondStat(redSamples, greenSamples,
        s => s.vwapDiff != null && s.vwapDiff < -0.5 && s.volRatio < 1,
        '收盘价跌破当日均价线 + 缩量'),
      makeCondStat(redSamples, greenSamples,
        s => s.vwapDiff != null && s.vwapDiff < -0.5 && s.vsMa5 < 0,
        '收盘价跌破当日均价线 + 股价在5日线下方'),
      // 反向信号：盘中杀跌后拉回（长下影线），次日绿盘概率反而更高（层内红盘率40.1%）
      makeCondStat(redSamples, greenSamples,
        s => s.lowShadow != null && s.lowShadow > 2,
        '盘中杀跌后拉回（长下影线>2%，次日偏弱）'),
      // 原有条件
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.volRatio < 1 && s.vsMa5 < 0, '前一天跌超3% + 缩量 + 股价在5日线下方'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -5 && s.volRatio < 0.8, '前一天跌超5% + 极度缩量'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.vsMa5 < -3, '前一天跌超3% + 股价偏离5日线3%以上'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.vsMa20 < -5, '前一天跌超3% + 股价偏离20日线5%以上'),
    ];
    const condStats = markBestMerged(dropSparse(condStatsRaw));

    // 每个维度找成功率最高（isBestRatio）和涨幅最高（isBestAvg）
    const bestVolRatio = volStats.find(x => x.isBestRatio);
    const bestVolAvg = volStats.find(x => x.isBestAvg);
    const bestMa5Ratio = ma5Stats.find(x => x.isBestRatio);
    const bestMa5Avg = ma5Stats.find(x => x.isBestAvg);
    const bestMa20Ratio = ma20Stats.find(x => x.isBestRatio);
    const bestMa20Avg = ma20Stats.find(x => x.isBestAvg);
    const bestDistRatio = distStats.find(x => x.isBestRatio);
    const bestDistAvg = distStats.find(x => x.isBestAvg);
    const bestVwapRatio = vwapStats.find(x => x.isBestRatio);
    const bestVwapAvg = vwapStats.find(x => x.isBestAvg);
    const bestShapeRatio = shapeStats.find(x => x.isBestRatio);
    const bestShapeAvg = shapeStats.find(x => x.isBestAvg);
    const bestAucRatio = aucStats.find(x => x.isBestRatio);
    const bestAucAvg = aucStats.find(x => x.isBestAvg);
    const bestCondRatio = condStats.find(x => x.isBestRatio);
    const bestCondAvg = condStats.find(x => x.isBestAvg);

    // 层内红盘率 = 该层红盘次数 / 该层总次数（真正意义上的"成功率"）
    const layerRate = x => {
      const c = x.red_count + x.green_count;
      return c > 0 ? (x.red_count / c * 100).toFixed(1) : '0.0';
    };

    const conclusions = {
      vol: `【成功率最高】${bestVolRatio ? bestVolRatio.label : 'N/A'}（层内红盘率${bestVolRatio ? layerRate(bestVolRatio) : '0'}%，${bestVolRatio ? bestVolRatio.red_count : 0}次）；【涨幅最高】${bestVolAvg ? bestVolAvg.label : 'N/A'}（红盘均涨${bestVolAvg ? bestVolAvg.red_avg : '0'}%）`,
      ma5: `【成功率最高】${bestMa5Ratio ? bestMa5Ratio.label : 'N/A'}（层内红盘率${bestMa5Ratio ? layerRate(bestMa5Ratio) : '0'}%，${bestMa5Ratio ? bestMa5Ratio.red_count : 0}次）；【涨幅最高】${bestMa5Avg ? bestMa5Avg.label : 'N/A'}（红盘均涨${bestMa5Avg ? bestMa5Avg.red_avg : '0'}%）`,
      ma20: `【成功率最高】${bestMa20Ratio ? bestMa20Ratio.label : 'N/A'}（层内红盘率${bestMa20Ratio ? layerRate(bestMa20Ratio) : '0'}%，${bestMa20Ratio ? bestMa20Ratio.red_count : 0}次）；【涨幅最高】${bestMa20Avg ? bestMa20Avg.label : 'N/A'}（红盘均涨${bestMa20Avg ? bestMa20Avg.red_avg : '0'}%）`,
      dist: `【成功率最高】${bestDistRatio ? bestDistRatio.label : 'N/A'}（层内红盘率${bestDistRatio ? layerRate(bestDistRatio) : '0'}%，${bestDistRatio ? bestDistRatio.red_count : 0}次）；【涨幅最高】${bestDistAvg ? bestDistAvg.label : 'N/A'}（红盘均涨${bestDistAvg ? bestDistAvg.red_avg : '0'}%）`,
      vwap: `【成功率最高】${bestVwapRatio ? bestVwapRatio.label : 'N/A'}（层内红盘率${bestVwapRatio ? layerRate(bestVwapRatio) : '0'}%，${bestVwapRatio ? bestVwapRatio.red_count : 0}次）；【涨幅最高】${bestVwapAvg ? bestVwapAvg.label : 'N/A'}（红盘均涨${bestVwapAvg ? bestVwapAvg.red_avg : '0'}%）`,
      shape: `【成功率最高】${bestShapeRatio ? bestShapeRatio.label : 'N/A'}（层内红盘率${bestShapeRatio ? layerRate(bestShapeRatio) : '0'}%，${bestShapeRatio ? bestShapeRatio.red_count : 0}次）；【涨幅最高】${bestShapeAvg ? bestShapeAvg.label : 'N/A'}（红盘均涨${bestShapeAvg ? bestShapeAvg.red_avg : '0'}%）`,
      auc: `【成功率最高】${bestAucRatio ? bestAucRatio.label : 'N/A'}（层内红盘率${bestAucRatio ? layerRate(bestAucRatio) : '0'}%，${bestAucRatio ? bestAucRatio.red_count : 0}次）；【涨幅最高】${bestAucAvg ? bestAucAvg.label : 'N/A'}（红盘均涨${bestAucAvg ? bestAucAvg.red_avg : '0'}%）`,
      cond: `【成功率最高】${bestCondRatio ? bestCondRatio.label : 'N/A'}（层内红盘率${bestCondRatio ? layerRate(bestCondRatio) : '0'}%，${bestCondRatio ? bestCondRatio.red_count : 0}次）；【涨幅最高】${bestCondAvg ? bestCondAvg.label : 'N/A'}（红盘均涨${bestCondAvg ? bestCondAvg.red_avg : '0'}%）`,
      overall: `综合来看，最优买入条件为【${bestCondAvg ? bestCondAvg.label : 'N/A'}】，红盘均涨最高（${bestCondAvg ? bestCondAvg.red_avg : '0'}%）；若追求稳定则关注【${bestCondRatio ? bestCondRatio.label : 'N/A'}】（层内红盘率${bestCondRatio ? layerRate(bestCondRatio) : '0'}%）。分时走势方面，收盘价与当日均价线的位置参考【${bestVwapRatio ? bestVwapRatio.label : ''}】，日内形态参考【${bestShapeRatio ? bestShapeRatio.label : ''}】；量能参考【${bestVolAvg ? bestVolAvg.label : ''}】，5日线参考【${bestMa5Avg ? bestMa5Avg.label : ''}】。`
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
        vwap_stats: vwapStats,
        shape_stats: shapeStats,
        auc_stats: aucStats,
        cond_stats: condStats,
        conclusions: conclusions,
        top10: top10.map(s => ({
          date: s.date,
          today_pct: s.today_pct.toFixed(2),
          next_pct: s.next_pct.toFixed(2),
          vol_ratio: s.volRatio.toFixed(2),
          vs_ma5: s.vsMa5.toFixed(1),
          vs_ma20: s.vsMa20.toFixed(1),
          turnover: s.turnoverRate.toFixed(1),
          vwap_diff: s.vwapDiff == null ? '—' : s.vwapDiff.toFixed(2),
          close_pos: s.closePos == null ? '—' : s.closePos.toFixed(0),
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
      if (!thscode) {
        const sr = await searchStock(stock_code);
        if (sr) thscode = sr.ts_code;
      }
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

app.listen(PORT, () => {
  console.log(`稻谷查查1.0 运行在 http://localhost:${PORT}`);
});
