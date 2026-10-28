const express = require('express');
const cors = require('cors');
const { analyze } = require('./backtest.js');
const validated = require('./validated.js');
const path = require('path');
const fs = require('fs');
const {
  fetchKline, fetchDailyBasic, fetchAuction, byDate, searchStock,
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
  const { stock_code } = req.body;
  let days = parseInt(req.body.days, 10);
  if (!stock_code) {
    return res.json({ code: 400, msg: '缺少stock_code参数' });
  }
  if (!isFinite(days) || days < 10) days = 120;          // days 非法时回退到默认，避免 NaN 触发 500
  days = Math.min(days, 500);

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
    let klineRows = null;
    let klineErr = null;
    let basicData = [];
    let auctionData = [];
    for (const years of [1, 2, 3]) {
      // 用 Date 构造起始日，避免 2月29日 落到非闰年产生非法日期串
      const sd = new Date(today.getFullYear() - years, today.getMonth(), today.getDate());
      const startDate = `${sd.getFullYear()}${String(sd.getMonth()+1).padStart(2,'0')}${String(sd.getDate()).padStart(2,'0')}`;
      const kr = await fetchKline(thscode, startDate, endDate);
      klineErr = { code: kr.code, msg: kr.msg };
      if (kr.ok && kr.rows.length > 10) {
        klineRows = kr.rows;
        // 分时走势所需的辅助数据（失败不阻断主流程）
        basicData = await fetchDailyBasic(thscode, startDate, endDate);
        auctionData = await fetchAuction(thscode, startDate, endDate);
        break;
      }
    }
    if (!klineRows || klineRows.length === 0) {
      // 区分「真的没有数据」和「上游报错」——把 token 失效说成"停牌"会把排查方向带偏
      const ec = klineErr && klineErr.code;
      if (ec === 2002) {
        return res.json({ code: 502, msg: '数据源令牌已失效或无访问权限，请联系管理员更新 Tushare Token' });
      }
      if (ec === 403) {
        return res.json({ code: 502, msg: '当前账号没有该接口的访问权限，请联系管理员开通' });
      }
      if (ec === 50101) {
        return res.json({ code: 502, msg: '数据源接口未开通或不可用，请联系管理员' });
      }
      return res.json({ code: 404, msg: `获取K线数据失败（可能是新股/次新股数据不足、已停牌退市，或数据源暂时限流，请稍后重试）${klineErr && klineErr.msg ? '｜上游提示：' + klineErr.msg : ''}` });
    }
    const klineData = klineRows;

    // 按日期索引辅助数据（停牌/节假日会导致日期不匹配，用日期对齐而非下标对齐）
    const basicMap = byDate(basicData);
    const auctionMap = byDate(auctionData);
    // 资金流向目前未参与任何统计，保留占位以备后续接入（不再每轮都去代理取数，避免加剧限流）
    const moneyflowMap = {};

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

    // 换手率：只信 daily_basic.turnover_rate（真实值）。
    // 早期用「成交额/估算流通股本」硬凑，那个估算误差可达数十倍，会污染分层与结论，
    // 因此这里不再伪造，取不到就留 null（显示为「换手率数据缺失」）。
    const turnoverRate = closes.map(() => null);

    // 取近days个交易日
    const n = Math.min(days, klineData.length - 1);
    // 样本太少时，任何"成功率100%"都是噪声，必须拦下来而不是照样出结论
    if (n < 20) {
      return res.json({
        code: 404,
        msg: `该股票可用交易日不足（仅 ${n} 天，可能为次新股），无法做统计，请稍后再试`
      });
    }
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
      // num() 把任何非有限数（NaN / Infinity）统一成 null，避免脏数据静默混进统计层
      const num = v => {
        const x = parseFloat(v);
        return (isFinite(x) && !isNaN(x)) ? x : null;
      };
      // 1) 当日均价线（VWAP）：Tushare amount 单位为千元，vol 单位为手
      //    均价 = amount*1000 / (vol*100) = amount*10 / vol
      const amt = num(row.amount);
      const volHands = num(row.vol);
      const vwap = (amt != null && volHands != null && volHands > 0) ? (amt * 10 / volHands) : null;
      const close = num(row.close);
      // 收盘价相对当日均价线的偏离（%）：负数 = 收盘价在均价线下方（尾盘偏弱）
      const vwapDiff = (vwap != null && close != null) ? (close - vwap) / vwap * 100 : null;

      // 2) 收盘价在当日最高/最低价区间中的位置（%）：低 = 收盘在当日低位
      //    一字板（high==low）单独标出，不当作「数据缺失」
      const high = num(row.high);
      const low = num(row.low);
      const open = num(row.open);
      let closePos = null, onePriceLimit = false;
      if (high != null && low != null && close != null) {
        if (high > low) {
          closePos = (close - low) / (high - low) * 100;
        } else if (high === low) {
          // 一字板：全天无波动，收盘位置没有意义，置 null（不能置 100，
          // 否则会被误判成「D 强势收盘：收在日内最高位且站上均价线」）
          onePriceLimit = true;
          closePos = null;
        }
      }

      // 3) 下影线占最低价比例（%）：长下影 = 盘中大幅杀跌后被拉回
      let lowShadow = null;
      if (low != null && low > 0 && close != null && open != null) {
        lowShadow = (Math.min(close, open) - low) / low * 100;
      }

      // 4) 集合竞价（真实盘口数据）
      const auc = auctionMap[row.trade_date];
      let aucRatio = null, aucGap = null;
      if (auc) {
        // 【单位】stk_auction.vol 单位是「股」，daily.vol 单位是「手」，两者不可相除。
        // 正确口径：今日竞价量 / 前5日【竞价】平均量（同源同单位）。
        let sum5 = 0, c5 = 0;
        for (let j = Math.max(0, idx - 5); j < idx; j++) {
          const prevAuc = auctionMap[klineData[j].trade_date];
          const pv = prevAuc && prevAuc.vol != null ? parseFloat(prevAuc.vol) : null;
          // 竞价量为 0 的异常日要剔除，否则会拉低均值、把放量误判成常量
          if (pv != null && pv > 0) { sum5 += pv; c5++; }
        }
        // 有效历史不足 3 天则判为缺失，不硬算
        const avg5 = c5 >= 3 ? sum5 / c5 : null;
        if (avg5 != null && auc.vol != null && parseFloat(auc.vol) > 0) {
          aucRatio = parseFloat(auc.vol) / avg5;
        }
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
        onePriceLimit: onePriceLimit,
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

    // 标记两个最优：成功率最高（层内红盘率）、涨幅最高（红盘均涨）
    // 规则：
    //  - 「数据缺失」类分层永远不参与评选（缺数据不是交易信号）
    //  - 参与评选的层至少要有 5 个红盘样本，否则 3~4 个样本也能"夺冠"，会误导用户
    //  - 【关键】候选层必须先通过「跨股票验证」（validated.js）。
    //    单只股票 120 个样本很容易把纯噪声层选成冠军——比如澳洋健康历史上
    //    「前一天跌超5%」红盘率 60% 看着很棒，但跨 10 只股票检验 p=0.98，纯噪声。
    //    所以：成功率只在「跨股验证为正向」的层里选，涨幅只在「跨股验证为高涨幅」的层里选。
    //    该维度若没有任何通过验证的正向层，就诚实地说「本维度没有验证过的稳定信号」。
    function markBestMerged(rows, dim) {
      const isMissing = x => /缺失/.test(x.label);
      const rateSet = validated.rateEligibleLabels(dim);
      const avgSet = validated.avgEligibleLabels(dim);
      const enough = x => !isMissing(x) && x.red_count >= 5 && x.sample_count >= 10;
      const rateOk = x => enough(x) && rateSet.has(x.label);
      const avgOk = x => enough(x) && avgSet.has(x.label);
      const rateCandidates = rows.filter(rateOk);
      const avgCandidates = rows.filter(avgOk);
      // "成功率" = 该层内红盘次数 / 该层总次数（不是占全样本的比例）
      const layerRate = x => {
        const c = x.red_count + x.green_count;
        return c > 0 ? x.red_count / c : 0;
      };
      const maxRate = rateCandidates.length ? Math.max(...rateCandidates.map(layerRate)) : null;
      const maxAvg = avgCandidates.length
        ? Math.max(...avgCandidates.map(x => parseFloat(x.red_avg))) : null;
      const EPS = 1e-9;
      return rows.map(x => {
        const sig = validated.signalOf(dim, x.label);
        return {
          ...x,
          signal: sig,                                   // 'pos' | 'neg' | null
          marginal: validated.isMarginal(dim, x.label), // true = 只是边缘显著
          isBestRatio: rateOk(x) && Math.abs(layerRate(x) - maxRate) < EPS,
          isBestAvg: avgOk(x) && Math.abs(parseFloat(x.red_avg) - maxAvg) < 1e-9,
        };
      });
    }

    // 1. 量比分层
    const volRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.volRatio < 0.7) return '缩量(<0.7)';
      if (s.volRatio < 1.2) return '正常(0.7-1.2)';
      if (s.volRatio < 2.0) return '放量(1.2-2.0)';
      return '巨量(>2.0)';
    });
    const volStats = markBestMerged(dropSparse(volRows), 'vol');

    // 2. MA5分层（偏离5日线百分比）
    const ma5Rows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.vsMa5 > 5) return '股价在5日线上方（偏离>5%）';
      if (s.vsMa5 > 0) return '股价在5日线上方（0~5%）';
      if (s.vsMa5 > -5) return '股价在5日线下方（0~-5%）';
      return '股价在5日线下方（偏离<-5%）';
    });
    const ma5Stats = markBestMerged(dropSparse(ma5Rows), 'ma5');

    // 3. MA20分层（偏离20日线百分比）
    const ma20Rows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.vsMa20 > 10) return '股价在20日线上方（偏离>10%）';
      if (s.vsMa20 > 0) return '股价在20日线上方（0~10%）';
      if (s.vsMa20 > -10) return '股价在20日线下方（0~-10%）';
      return '股价在20日线下方（偏离<-10%）';
    });
    const ma20Stats = markBestMerged(dropSparse(ma20Rows), 'ma20');

    // 4. 换手率分层（依赖 daily_basic，取不到就整层缺失，不伪造）
    const turnRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.turnoverRate == null || !isFinite(s.turnoverRate)) return '换手率数据缺失';
      if (s.turnoverRate < 1) return '低换(<1%)';
      if (s.turnoverRate <= 3) return '正常(1-3%)';
      if (s.turnoverRate <= 6) return '高换(3-6%)';
      return '巨量换手(>6%)';
    });
    const turnStats = markBestMerged(dropSparse(turnRows), 'turn');

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
    const distStats = markBestMerged(dropSparse(distRows), 'dist');

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
    const vwapStats = markBestMerged(dropSparse(vwapRows), 'vwap');

    // 7. 日内K线形态：收盘位置 × 均价线偏离 交叉分档
    // 为什么用交叉表而不是「先看有没有长下影、再看收盘位置」：
    //   收盘位置 与 均价线偏离 高度相关（Spearman 0.90），拆成两个独立分层会重复计票；
    //   交叉后「A 弱势收盘」层是全维度统计最稳的一层（层内红盘率 55.4%，p=0.0015，9/10 只股票方向一致）。
    const shapeRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.onePriceLimit) return '一字板（当天无波动）';
      if (s.closePos == null || s.vwapDiff == null) return '日内形态数据缺失';
      if (s.closePos <= 10 && s.vwapDiff < -0.5) return 'A 弱势收盘（收在日内最低位且破均价线）';
      if (s.closePos >= 80 && s.vwapDiff > 0.5) return 'D 强势收盘（收在日内最高位且站上均价线）';
      if (s.vwapDiff < -0.5) return 'B 破均价线但未收在最低位';
      if (s.vwapDiff > 0.5) return 'C 站上均价线但未收在最高位';
      return 'E 全天围绕均价线震荡（±0.5%）';
    });
    const shapeStats = markBestMerged(dropSparse(shapeRows, 5), 'shape');

    // 8. 集合竞价强弱（真实盘口数据）
    // 口径：今日竞价量 / 前5日【竞价】平均量（同源同单位，stk_auction.vol 单位=股）
    // 必须切成 4 档：原来 3 档把「1.2~2.5 倍」和「≥2.5 倍」混成「放量」一档，
    // 把稳健的温和放量信号稀释掉了。4 档后「竞价温和放量 1.2~2.5 倍」层内红盘率 53.2%
    // （z=3.39，p=0.0007，8/10 只股票方向一致）。
    const aucRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.aucRatio == null) return '集合竞价数据缺失';
      if (s.aucRatio < 0.8) return '竞价缩量（<近5日竞价均量0.8倍）';
      if (s.aucRatio < 1.2) return '竞价常量（0.8~1.2倍）';
      if (s.aucRatio < 2.5) return '竞价温和放量（1.2~2.5倍）';
      return '竞价过度放量（≥2.5倍）';
    });
    const aucStats = markBestMerged(dropSparse(aucRows, 5), 'auc');

    // 9. 长下影（盘中杀跌后拉回）—— 分时走势里唯一稳定的看空形态
    // 阈值取 1.5%：2% 时各季度表现不稳（7 只有效股票），降到 1.5% 后 8 只股票方向一致、
    // 季度 44/33/37/45 均低于同期其余样本，bootstrap 复现率 0%（即负向极稳）。
    const wickRows = mergeStatBy(redSamples, greenSamples, s => {
      if (s.lowShadow == null) return '下影线数据缺失';
      return s.lowShadow > 1.5 ? '盘中杀跌后拉回（下影线>1.5%）' : '无长下影（下影线≤1.5%）';
    });
    const wickStats = markBestMerged(dropSparse(wickRows, 5), 'wick');

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
      // 反向信号：盘中杀跌后拉回（长下影线），次日绿盘概率反而更高（层内红盘率40.5%）
      makeCondStat(redSamples, greenSamples,
        s => s.lowShadow != null && s.lowShadow > 1.5,
        '盘中杀跌后拉回（下影线>1.5%，次日偏弱）'),
      makeCondStat(redSamples, greenSamples,
        s => s.lowShadow != null && s.lowShadow > 1.5 && s.vsMa5 < 0,
        '盘中杀跌后拉回（下影线>1.5%）+ 股价在5日线下方'),
      // 原有条件
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.volRatio < 1 && s.vsMa5 < 0, '前一天跌超3% + 缩量 + 股价在5日线下方'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -5 && s.volRatio < 0.8, '前一天跌超5% + 极度缩量'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.vsMa5 < -3, '前一天跌超3% + 股价偏离5日线3%以上'),
      makeCondStat(redSamples, greenSamples, s => s.today_pct < -3 && s.vsMa20 < -5, '前一天跌超3% + 股价偏离20日线5%以上'),
      // —— 集合竞价温和放量（1.2~2.5倍）单独是一个正向信号，与日内形态几乎正交，
      //    叠加「当日缩量」后是全表最稳的一行（层内红盘率58.7%，z=3.97，8/10 只股票方向一致）
      makeCondStat(redSamples, greenSamples,
        s => s.aucRatio != null && s.aucRatio >= 1.2 && s.aucRatio < 2.5 && s.volRatio < 1,
        '集合竞价温和放量（1.2~2.5倍） + 当日缩量'),
      // —— 弱势收盘（A层）+ 缩量：层内红盘率61.2%，z=4.00，9/10 只股票方向一致
      makeCondStat(redSamples, greenSamples,
        s => s.closePos != null && s.closePos <= 10 && s.vwapDiff != null && s.vwapDiff < -0.5 && s.volRatio < 1,
        '收盘价跌破均价线 + 收在日内最低位 + 缩量'),
    ];
    const condStats = markBestMerged(dropSparse(condStatsRaw), 'cond');

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
    const bestWickRatio = wickStats.find(x => x.isBestRatio);
    // 某个维度如果只有「反向信号」（比如长下影），总体结论里要写成看空提示，
    // 而不是一句「暂无」让用户以为没信号。
    const dimPickText = (rows, dim, flag) => {
      const hit = rows.find(x => x[flag]);
      if (hit) return hit.label;
      const neg = validated.negativeLabels(dim);
      const negHit = rows.find(x => neg.has(x.label));
      if (negHit) return `${negHit.label}（反向信号，次日更容易绿）`;
      // 没有冠军时把原因带上，别只写「暂无」
      const set = flag === 'isBestRatio'
        ? validated.rateEligibleLabels(dim)
        : validated.avgEligibleLabels(dim);
      const qualified = rows.filter(x => set.has(x.label));
      if (qualified.length) {
        const mx = Math.max(...qualified.map(x => x.sample_count));
        return `${mx}次样本不足，暂无`;
      }
      return '该维度无稳定信号';
    };
    const bestCondRatio = condStats.find(x => x.isBestRatio);
    const bestCondAvg = condStats.find(x => x.isBestAvg);

    // 层内红盘率 = 该层红盘次数 / 该层总次数（真正意义上的"成功率"）
    const layerRate = x => {
      const c = x.red_count + x.green_count;
      return c > 0 ? (x.red_count / c * 100).toFixed(1) : '0.0';
    };

    // 结论文案：没有达标层时给出可解释的兜底，而不是空白/N/A
    const pick = (rows, flag) => rows.find(x => x[flag]);
    // 找不到冠军时，必须说清「为什么」，三种原因要分清：
    //   1) 数据缺失          —— 这个维度压根没数据
    //   2) 跨股验证里没信号   —— 这个维度的层在 10 只股票上就没通过检验
    //   3) 本股票样本不够     —— 跨股验证通过了，但在这只股票上只出现几次
    const fallbackText = (rows, dim, which) => {
      const usable = rows.filter(x => !/缺失/.test(x.label));
      if (!usable.length) return '该维度数据缺失，无法给出结论';
      const set = which === 'rate'
        ? validated.rateEligibleLabels(dim)
        : validated.avgEligibleLabels(dim);
      const qualified = usable.filter(x => set.has(x.label));
      if (!qualified.length) {
        // 该维度可能只有「反向信号」（如长下影），这时不能说「没信号」
        if (which === 'rate' && validated.negativeLabels(dim).size) {
          return '本维度只有反向信号（见后），没有验证过的正向信号';
        }
        return '该维度在10只股票3335个样本的跨股验证中未发现稳定信号，暂不给出结论';
      }
      // 层本身通过了跨股验证，但在本股票上样本量不够
      // 要说清到底是「出现次数不够」还是「红盘次数不够」，不能笼统说「样本不足」
      const totalNeeded = 10, redNeeded = 5;
      const best = qualified.slice().sort((a, b) => b.sample_count - a.sample_count)[0];
      const mxTotal = Math.max(...qualified.map(x => x.sample_count));
      const mxRed = Math.max(...qualified.map(x => x.red_count));
      if (mxTotal < totalNeeded) {
        return `本股票该形态只出现 ${mxTotal} 次（需至少 ${totalNeeded} 次），样本不足暂不给出结论`;
      }
      if (mxRed < redNeeded) {
        return `本股票该形态共出现 ${best.sample_count} 次，但其中红盘只有 ${mxRed} 次（需至少 ${redNeeded} 次红盘样本才能算均涨），样本不足暂不给出结论`;
      }
      return `本股票该形态出现 ${best.sample_count} 次、红盘 ${best.red_count} 次，仍未满足评选条件，暂不给出结论`;
    };
    // 该维度有没有通过验证的反向信号（次日更容易绿），有就把「看空层」点出来
    const negativeSignalText = (rows, dim) => {
      const neg = validated.negativeLabels(dim);
      const hit = neg.size ? rows.find(x => neg.has(x.label)) : null;
      if (hit) {
        return `反向信号（次日更容易绿）：${hit.label}（本股票层内红盘率仅 ${layerRate(hit)}%）`;
      }
      // 边缘显著的反向信号：方向一致但检验没过 0.05，只能作参考
      const marg = validated.marginalNegativeLabels(dim);
      const mHit = marg.size ? rows.find(x => marg.has(x.label)) : null;
      if (mHit) {
        return `边缘反向信号（仅供参考）：${mHit.label}（本股票层内红盘率 ${layerRate(mHit)}%）`;
      }
      return null;
    };
    const conclusionText = (rows, dim) => {
      const r = pick(rows, 'isBestRatio'), a = pick(rows, 'isBestAvg');
      const negTxt = negativeSignalText(rows, dim);
      const ratioPart = r
        ? `【成功率最高】${r.label}（层内红盘率${layerRate(r)}%，${r.red_count}次）`
        : `【成功率最高】${fallbackText(rows, dim, 'rate')}`;
      const avgPart = a
        ? `【涨幅最高】${a.label}（红盘均涨${a.red_avg}%）`
        : `【涨幅最高】${fallbackText(rows, dim, 'avg')}`;
      return `${ratioPart}；${avgPart}${negTxt ? `；${negTxt}` : ''}`;
    };

    const conclusions = {
      vol: conclusionText(volStats, 'vol'),
      ma5: conclusionText(ma5Stats, 'ma5'),
      ma20: conclusionText(ma20Stats, 'ma20'),
      dist: conclusionText(distStats, 'dist'),
      vwap: conclusionText(vwapStats, 'vwap'),
      shape: conclusionText(shapeStats, 'shape'),
      auc: conclusionText(aucStats, 'auc'),
      wick: conclusionText(wickStats, 'wick'),
      cond: conclusionText(condStats, 'cond'),
      overall: `综合来看，最优买入条件为【${bestCondAvg ? bestCondAvg.label : '暂无'}】，红盘均涨最高（${bestCondAvg ? bestCondAvg.red_avg : '0'}%）；若追求稳定则关注【${bestCondRatio ? bestCondRatio.label : '暂无'}】（层内红盘率${bestCondRatio ? layerRate(bestCondRatio) : '0'}%）。分时走势方面，日内形态最关键的是【${dimPickText(shapeStats, 'shape', 'isBestRatio')}】（层内红盘率${bestShapeRatio ? layerRate(bestShapeRatio) : '0'}%），收盘价与当日均价线的位置参考【${dimPickText(vwapStats, 'vwap', 'isBestRatio')}】，集合竞价量能参考【${dimPickText(aucStats, 'auc', 'isBestRatio')}】，长下影形态参考【${dimPickText(wickStats, 'wick', 'isBestRatio')}】；量能参考【${dimPickText(volStats, 'vol', 'isBestAvg')}】，5日线参考【${dimPickText(ma5Stats, 'ma5', 'isBestAvg')}】。注意：只有通过跨股票验证的层才会被标为「最高」，没验证过的维度会直说「无稳定信号」，不用单股噪声层充数。`
    };

    // Top10红盘样本
    const top10 = [...redSamples].sort((a, b) => b.next_pct - a.next_pct).slice(0, 10);

    // 检查数据是否太老（超过30个自然日无新数据）
    const lastTradeDate = analysisEndDate;
    const lastTradeTs = new Date(lastTradeDate.slice(0,4), parseInt(lastTradeDate.slice(4,6))-1, lastTradeDate.slice(6,8)).getTime();
    const todayTs = new Date().getTime();
    const daysSinceLastTrade = Math.floor((todayTs - lastTradeTs) / 86400000);
    const dataIsStale = daysSinceLastTrade > 30;

    // 一句话结论（供历史记录徽章等场景显示）
    const headline = bestCondRatio
      ? `成功率最高：${bestCondRatio.label}（${layerRate(bestCondRatio)}%）`
      : (bestCondAvg
        ? `涨幅最高：${bestCondAvg.label}`
        : `条件样本偏少（各层最多 ${Math.max(0, ...condStats.map(x => x.sample_count))} 次），仅供参考`);

    res.json({
      code: 0,
      data: {
        stock_code: thscode,
        stock_name: stockName,
        days: n,
        headline: headline,
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
        wick_stats: wickStats,
        cond_stats: condStats,
        conclusions: conclusions,
        top10: top10.map(s => ({
          date: s.date,
          today_pct: s.today_pct.toFixed(2),
          next_pct: s.next_pct.toFixed(2),
          vol_ratio: s.volRatio.toFixed(2),
          vs_ma5: s.vsMa5.toFixed(1),
          vs_ma20: s.vsMa20.toFixed(1),
          turnover: s.turnoverRate == null || !isFinite(s.turnoverRate) ? '—' : s.turnoverRate.toFixed(1),
          vwap_diff: s.vwapDiff == null ? '—' : s.vwapDiff.toFixed(2),
          close_pos: s.closePos == null ? '—' : s.closePos.toFixed(0),
          low_shadow: s.lowShadow == null ? '—' : s.lowShadow.toFixed(2),
          auc_ratio: s.aucRatio == null ? '—' : s.aucRatio.toFixed(2),
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

    const kr = await fetchKline(thscode, '20250101', endDate);
    if (!kr.ok || kr.rows.length === 0) {
      const ec = kr.code;
      if (ec === 2002) return res.json({ code: 502, msg: '数据源令牌已失效或无访问权限，请联系管理员更新 Tushare Token' });
      if (ec === 403) return res.json({ code: 502, msg: '当前账号没有该接口的访问权限，请联系管理员开通' });
      return res.json({ code: 404, msg: `获取K线数据失败（可能停牌或代码错误，或数据源暂时限流）${kr.msg ? '｜上游提示：' + kr.msg : ''}` });
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
