// 跨股票验证门控的单元测试
// 验证：只有通过跨股验证的层才能被标为「成功率最高 / 涨幅最高」，
//      未通过的维度必须给出诚实的原因，而不是拿单股噪声层充数。
const assert = require('assert');
const validated = require('../server/validated.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('✅ ' + name); pass++; }
  catch (e) { console.log('❌ ' + name + ' —— ' + e.message); fail++; }
}

// 模拟服务端 markBestMerged 的核心逻辑（保持与 index.js 一致的判定）
function markBestMerged(rows, dim) {
  const isMissing = x => /缺失/.test(x.label);
  const rateSet = validated.rateEligibleLabels(dim);
  const avgSet = validated.avgEligibleLabels(dim);
  const enough = x => !isMissing(x) && x.red_count >= 5 && x.sample_count >= 10;
  const rateOk = x => enough(x) && rateSet.has(x.label);
  const avgOk = x => enough(x) && avgSet.has(x.label);
  const rateCandidates = rows.filter(rateOk);
  const avgCandidates = rows.filter(avgOk);
  const layerRate = x => (x.red_count + x.green_count) > 0 ? x.red_count / (x.red_count + x.green_count) : 0;
  const maxRate = rateCandidates.length ? Math.max(...rateCandidates.map(layerRate)) : null;
  const maxAvg = avgCandidates.length ? Math.max(...avgCandidates.map(x => parseFloat(x.red_avg))) : null;
  const EPS = 1e-9;
  return rows.map(x => ({
    ...x,
    signal: validated.signalOf(dim, x.label),
    isBestRatio: rateOk(x) && Math.abs(layerRate(x) - maxRate) < EPS,
    isBestAvg: avgOk(x) && Math.abs(parseFloat(x.red_avg) - maxAvg) < 1e-9,
  }));
}

const row = (label, red, green, avg) => ({
  label, red_count: red, green_count: green,
  red_avg: avg || '2.00', sample_count: red + green,
});

// 服务端源码全文（分层文案有些已经抽到独立模块里，所以把 server/ 下所有 js 都拼起来检索）
function readServerSource() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'server');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

console.log('\n=== 1) 未验证的层不得夺冠 ===');
check('澳洋健康的「前一天跌超5%」这种单股噪声层不能拿成功率第一', () => {
  // 该层在跨股验证里 p=0.98（纯噪声），但单股上红盘率很高
  const rows = [
    row('<-5%', 6, 4, '8.37'),           // 单股红盘率 60%，看着很棒
    row('收盘价低于当日均价线0.5%以上', 17, 19, '5.10'),  // 已验证（vwap 维度）
  ];
  const out = markBestMerged(rows, 'vwap');
  const noise = out.find(x => x.label === '<-5%');
  const good = out.find(x => x.label === '收盘价低于当日均价线0.5%以上');
  assert.strictEqual(noise.isBestRatio, false, '噪声层不应被标为成功率最高');
  assert.strictEqual(good.isBestRatio, true, '已验证层应被标为成功率最高');
});

check('未验证的「前一天涨1~3%」在 dist 维度也拿不到成功率第一', () => {
  // dist 维度唯一的验证结论是反向信号，正向层为空 → 不该有冠军
  const rows = [row('1~3%', 20, 12, '3.00'), row('<-5%', 6, 4, '8.37')];
  const out = markBestMerged(rows, 'dist');
  out.forEach(x => assert.strictEqual(x.isBestRatio, false, 'dist 维度没有正向验证层，不应有冠军'));
  assert.strictEqual(out.find(x => x.label === '1~3%').signal, 'neg', '1~3% 应是反向信号');
});

check('未通过验证的维度不会产生任何冠军', () => {
  const rows = [row('股价在5日线上方（0~5%）', 17, 23, '4.25')];
  const out = markBestMerged(rows, 'ma5');
  assert.strictEqual(out[0].isBestRatio, false, 'ma5 维度没有验证过的正向层，不应有冠军');
});

console.log('\n=== 2) 已验证层能正常夺冠 ===');
check('竞价温和放量能拿集合竞价维度的成功率第一', () => {
  const rows = [
    row('竞价缩量（<近5日竞价均量0.8倍）', 25, 34, '4.33'),
    row('竞价常量（0.8~1.2倍）', 11, 7, '4.93'),
    row('竞价温和放量（1.2~2.5倍）', 12, 13, '3.00'),
    row('竞价过度放量（≥2.5倍）', 3, 8, '7.61'),
  ];
  const out = markBestMerged(rows, 'auc');
  const mild = out.find(x => x.label === '竞价温和放量（1.2~2.5倍）');
  const constant = out.find(x => x.label === '竞价常量（0.8~1.2倍）');
  assert.strictEqual(mild.isBestRatio, true, '竞价温和放量应夺冠（它是唯一验证过的正向层）');
  assert.strictEqual(constant.isBestRatio, false, '竞价常量未通过验证，不应夺冠');
});

check('长下影层被标成反向信号，且不参与成功率评选', () => {
  const rows = [
    row('无长下影（下影线≤1.5%）', 37, 44, '4.20'),
    row('盘中杀跌后拉回（下影线>1.5%）', 14, 18, '4.71'),
  ];
  const out = markBestMerged(rows, 'wick');
  const wick = out.find(x => x.label === '盘中杀跌后拉回（下影线>1.5%）');
  assert.strictEqual(wick.signal, 'neg', '长下影应标记为反向信号');
  assert.strictEqual(wick.isBestRatio, false, '反向信号不能拿成功率第一');
});

console.log('\n=== 3) 样本量门槛仍然生效 ===');
check('已验证但样本太少的层不能夺冠', () => {
  // 收盘价低于均价线 0.5% 以上 —— 已验证，但本股票只有 6 次
  const rows = [row('收盘价低于当日均价线0.5%以上', 4, 2, '5.10')];
  const out = markBestMerged(rows, 'vwap');
  assert.strictEqual(out[0].isBestRatio, false, '样本不足不应夺冠');
});

check('数据缺失层永远不参与评选', () => {
  const rows = [row('当日均价数据缺失', 50, 50, '9.99')];
  const out = markBestMerged(rows, 'vwap');
  assert.strictEqual(out[0].isBestRatio, false, '缺失层不应夺冠');
  assert.strictEqual(out[0].isBestAvg, false, '缺失层不应夺冠');
});

console.log('\n=== 4) 涨幅冠军也必须通过验证 ===');
check('未通过涨幅验证的层不能拿涨幅第一', () => {
  const rows = [
    row('放量(1.2-2.0)', 7, 13, '3.26'),            // 已验证（8/10 股票）
    row('巨量(>2.0)', 3, 3, '7.72'),                // 未验证
  ];
  const out = markBestMerged(rows, 'vol');
  assert.strictEqual(out.find(x => x.label === '放量(1.2-2.0)').isBestAvg, true);
  assert.strictEqual(out.find(x => x.label === '巨量(>2.0)').isBestAvg, false);
});

console.log('\n=== 5) 验证表自身的一致性 ===');
check('每个维度的正向层集合与 negativeLabels 不重叠', () => {
  ['vol', 'ma5', 'ma20', 'dist', 'cond', 'vwap', 'shape', 'auc', 'wick', 'fenshi'].forEach(dim => {
    const pos = validated.rateEligibleLabels(dim);
    const neg = validated.negativeLabels(dim);
    pos.forEach(l => assert.strictEqual(neg.has(l), false, `${dim}/${l} 同时被标成正反向`));
  });
});

check('验证表里所有层的 p 值都小于 0.05，或明确标注为边缘', () => {
  Object.keys(validated.CROSS_VALIDATED_RATE).forEach(dim => {
    Object.keys(validated.CROSS_VALIDATED_RATE[dim]).forEach(l => {
      const v = validated.CROSS_VALIDATED_RATE[dim][l];
      if (v.marginal) {
        // 边缘层（p 在 0.05~0.10）：方向一致但检验没过 0.05，
        // 正负都允许，但一律不能参与任何评选，只在结论里提示。
        assert.ok(v.dir === 'pos' || v.dir === 'neg', `${dim}/${l} 边缘信号方向非法`);
        assert.ok(v.p >= 0.05 && v.p < 0.10, `${dim}/${l} 边缘信号 p=${v.p} 应在 0.05~0.10`);
        assert.ok(!validated.rateEligibleLabels(dim).has(l), `${dim}/${l} 边缘层不能参与成功率评选`);
        assert.ok(!validated.negativeLabels(dim).has(l), `${dim}/${l} 边缘层不能进强负向集合`);
        if (v.dir === 'neg') {
          assert.ok(validated.marginalNegativeLabels(dim).has(l), `${dim}/${l} 应在边缘负向集合里`);
        } else {
          assert.ok(validated.marginalPositiveLabels(dim).has(l), `${dim}/${l} 应在边缘正向集合里`);
        }
      } else {
        assert.ok(v.p < 0.05, `${dim}/${l} 的 p=${v.p} 不该出现在验证表里`);
      }
      assert.ok(v.stocks >= 7, `${dim}/${l} 方向一致性只有 ${v.stocks}/10`);
    });
  });
});

check('所有验证过的层标签都真实存在于对应维度的分层里', () => {
  // 防止改了服务端分档文案却忘了同步验证表（会导致信号静默失效）
  const src = readServerSource();
  const dimChecks = {
    vol: ['缩量(<0.7)', '放量(1.2-2.0)'],
    ma5: ['股价在5日线上方（偏离>5%）', '股价在5日线下方（0~-5%）'],
    ma20: ['股价在20日线上方（偏离>10%）', '股价在20日线下方（0~-10%）'],
    dist: ['>5%', '1~3%', '<-5%'],
    vwap: ['收盘价低于当日均价线0.5%以上', '收盘价高于当日均价线0.5%以上'],
    shape: ['A 弱势收盘（收在日内最低位且破均价线）', 'D 强势收盘（收在日内最高位且站上均价线）'],
    auc: ['竞价温和放量（1.2~2.5倍）', '竞价缩量（<近5日竞价均量0.8倍）', '竞价过度放量（≥2.5倍）'],
    wick: ['盘中杀跌后拉回（下影线>1.5%）', '无长下影（下影线≤1.5%）'],
    fenshi: ['S1 早盘冲高回落', 'S2 早盘探底后回升', 'S5 均价线上翘（重心上移）', 'S7 横盘整理（均价线走平）'],
    cond: ['收盘价跌破当日均价线 + 缩量 + 股价在5日线下方',
            '集合竞价温和放量（1.2~2.5倍） + 当日缩量',
            '收盘价跌破均价线 + 收在日内最低位 + 缩量'],
  };
  Object.keys(dimChecks).forEach(dim => {
    dimChecks[dim].forEach(l => {
      assert.ok(src.includes(l), `服务端里找不到分层文案「${l}」（维度 ${dim}）`);
    });
  });
});

check('验证表里的层名在服务端都能被检索到', () => {
  const src = readServerSource();
  Object.keys(validated.CROSS_VALIDATED_RATE).forEach(dim => {
    Object.keys(validated.CROSS_VALIDATED_RATE[dim]).forEach(l => {
      assert.ok(src.includes(l), `服务端找不到验证过的层「${l}」（维度 ${dim}）`);
    });
  });
  Object.keys(validated.CROSS_VALIDATED_AVG).forEach(dim => {
    Object.keys(validated.CROSS_VALIDATED_AVG[dim]).forEach(l => {
      assert.ok(src.includes(l), `服务端找不到涨幅验证过的层「${l}」（维度 ${dim}）`);
    });
  });
});

console.log('\n=== 6) 日内形态维度 ===');
check('S1 早盘冲高回落是唯一能拿「成功率最高」的形态', () => {
  const rows = [
    row('S1 早盘冲高回落', 18, 16, '2.02'),
    row('S2 早盘探底后回升', 15, 21, '2.07'),
    row('S5 均价线上翘（重心上移）', 12, 17, '2.51'),
    row('S7 横盘整理（均价线走平）', 20, 19, '1.93'),
    row('S3 早盘见顶后阴跌', 16, 18, '1.89'),
  ];
  const out = markBestMerged(rows, 'fenshi');
  assert.strictEqual(out.find(x => x.label === 'S1 早盘冲高回落').isBestRatio, true);
  // 反向层不能拿成功率第一
  assert.strictEqual(out.find(x => x.label === 'S2 早盘探底后回升').isBestRatio, false);
  assert.strictEqual(out.find(x => x.label === 'S5 均价线上翘（重心上移）').isBestRatio, false);
  // 边缘正向层（S7，p=0.0628）也不能拿成功率第一
  assert.strictEqual(out.find(x => x.label === 'S7 横盘整理（均价线走平）').isBestRatio, false);
  // 未验证的形态（S3）更不能
  assert.strictEqual(out.find(x => x.label === 'S3 早盘见顶后阴跌').isBestRatio, false);
});

check('S2 / S5 被标成反向信号，S7 被标成边缘信号', () => {
  const rows = [
    row('S2 早盘探底后回升', 15, 21, '2.07'),
    row('S5 均价线上翘（重心上移）', 12, 17, '2.51'),
    row('S7 横盘整理（均价线走平）', 20, 19, '1.93'),
  ];
  const out = markBestMerged(rows, 'fenshi');
  assert.strictEqual(out.find(x => x.label === 'S2 早盘探底后回升').signal, 'neg');
  assert.strictEqual(out.find(x => x.label === 'S5 均价线上翘（重心上移）').signal, 'neg');
  assert.strictEqual(out.find(x => x.label === 'S7 横盘整理（均价线走平）').signal, 'pos');
  assert.strictEqual(validated.isMarginal('fenshi', 'S7 横盘整理（均价线走平）'), true);
});

check('日内形态维度没有涨幅冠军（形态不改幅度）', () => {
  const rows = [
    row('S1 早盘冲高回落', 18, 16, '2.02'),
    row('S4 尾盘拉升', 6, 2, '2.72'),
  ];
  const out = markBestMerged(rows, 'fenshi');
  out.forEach(x => assert.strictEqual(x.isBestAvg, false, '形态维度不该有涨幅冠军'));
  assert.strictEqual(validated.avgEligibleLabels('fenshi').size, 0);
});

check('服务端的形态判定规则和验证表里的层名一一对应', () => {
  const fenshiMod = require('../server/fenshi.js');
  const labels = fenshiMod.ALL.map(s => s.label);
  assert.strictEqual(labels.length, 8, '应有 7 种形态 + 其他');
  assert.strictEqual(new Set(labels).size, 8, '形态层名不能重复');
  // 验证表里出现的每个层名，都必须是真实的形态层名
  Object.keys(validated.CROSS_VALIDATED_RATE.fenshi).forEach(l => {
    assert.ok(labels.includes(l), `验证表里的「${l}」不是合法形态层名`);
  });
});

check('服务端形态规则与研究阶段完全一致（3395 天逐日比对）', () => {
  // 规则抄错不会报错、只会静默给出错的「成功率最高」，所以必须逐日比对
  const fs = require('fs');
  const path = require('path');
  const researchDir = path.join(__dirname, '..', '_research');
  if (!fs.existsSync(path.join(researchDir, 'dataset.json'))) {
    console.log('   （跳过：研究样本集不在本地）');
    return;
  }
  const dataset = JSON.parse(fs.readFileSync(path.join(researchDir, 'dataset.json'), 'utf8'));
  const researchRules = require(path.join(researchDir, 'shape_rules.js'));
  const fenshiMod = require('../server/fenshi.js');
  const bsdataDir = path.join(researchDir, 'bsdata');
  let checked = 0, mismatch = 0;
  for (const code of [...new Set(dataset.map(s => s.code))]) {
    const minPath = path.join(bsdataDir, `${code}_5min.json`);
    const dayPath = path.join(bsdataDir, `${code}_daily.json`);
    if (!fs.existsSync(minPath) || !fs.existsSync(dayPath)) continue;
    const min = JSON.parse(fs.readFileSync(minPath, 'utf8'));
    const day = JSON.parse(fs.readFileSync(dayPath, 'utf8'));
    const days = {};
    min.rows.forEach(r => {
      const d = r[0];
      if (!days[d]) days[d] = { bars: [], ohlc: null };
      days[d].bars.push({ t: r[1].slice(8, 12), o: +r[3], h: +r[4], l: +r[5], c: +r[6], v: +r[7], a: +r[8] });
    });
    day.rows.forEach(r => {
      const d = r[0];
      if (!days[d]) days[d] = { bars: [], ohlc: null };
      days[d].ohlc = { open: +r[2], high: +r[3], low: +r[4], close: +r[5], volume: +r[6], amount: +r[7] };
    });
    Object.keys(days).forEach(d => {
      days[d].bars.sort((x, y) => x.t.localeCompare(y.t));
      if (!days[d].ohlc) delete days[d];
    });
    const built = fenshiMod.buildShapes({ days });
    dataset.filter(s => s.code === code).forEach(s => {
      const want = researchRules.classifyShape(s.feats);
      const got = built[s.date];
      if (!got) return;
      checked++;
      if (got.id !== want) mismatch++;
    });
  }
  assert.ok(checked > 3000, `比对样本太少（${checked}），校验没意义`);
  assert.strictEqual(mismatch, 0, `服务端与研究阶段有 ${mismatch} 天判定不一致`);
});

console.log(`\n${fail === 0 ? '全部通过 ✅' : fail + ' 个失败 ❌'}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
