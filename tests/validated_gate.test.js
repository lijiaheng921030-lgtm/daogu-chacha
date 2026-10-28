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
  ['vol', 'ma5', 'ma20', 'dist', 'cond', 'vwap', 'shape', 'auc', 'wick'].forEach(dim => {
    const pos = validated.rateEligibleLabels(dim);
    const neg = validated.negativeLabels(dim);
    pos.forEach(l => assert.strictEqual(neg.has(l), false, `${dim}/${l} 同时被标成正反向`));
  });
});

check('验证表里所有层的 p 值都小于 0.05，或明确标注为边缘负向', () => {
  Object.keys(validated.CROSS_VALIDATED_RATE).forEach(dim => {
    Object.keys(validated.CROSS_VALIDATED_RATE[dim]).forEach(l => {
      const v = validated.CROSS_VALIDATED_RATE[dim][l];
      if (v.marginal) {
        // 边缘层只允许是负向信号（提示「更容易绿」），且 p 必须落在 0.05~0.10
        assert.strictEqual(v.dir, 'neg', `${dim}/${l} 边缘信号只能是负向`);
        assert.ok(v.p >= 0.05 && v.p < 0.10, `${dim}/${l} 边缘信号 p=${v.p} 应在 0.05~0.10`);
        assert.ok(!validated.rateEligibleLabels(dim).has(l), `${dim}/${l} 边缘层不能参与成功率评选`);
        assert.ok(!validated.negativeLabels(dim).has(l), `${dim}/${l} 边缘层不能进强负向集合`);
        assert.ok(validated.marginalNegativeLabels(dim).has(l), `${dim}/${l} 应在边缘负向集合里`);
      } else {
        assert.ok(v.p < 0.05, `${dim}/${l} 的 p=${v.p} 不该出现在验证表里`);
      }
      assert.ok(v.stocks >= 7, `${dim}/${l} 方向一致性只有 ${v.stocks}/10`);
    });
  });
});

check('所有验证过的层标签都真实存在于对应维度的分层里', () => {
  // 防止改了服务端分档文案却忘了同步验证表（会导致信号静默失效）
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../server/index.js'), 'utf8');
  const dimChecks = {
    vol: ['缩量(<0.7)', '放量(1.2-2.0)'],
    ma5: ['股价在5日线上方（偏离>5%）', '股价在5日线下方（0~-5%）'],
    ma20: ['股价在20日线上方（偏离>10%）', '股价在20日线下方（0~-10%）'],
    dist: ['>5%', '1~3%', '<-5%'],
    vwap: ['收盘价低于当日均价线0.5%以上', '收盘价高于当日均价线0.5%以上'],
    shape: ['A 弱势收盘（收在日内最低位且破均价线）', 'D 强势收盘（收在日内最高位且站上均价线）'],
    auc: ['竞价温和放量（1.2~2.5倍）', '竞价缩量（<近5日竞价均量0.8倍）', '竞价过度放量（≥2.5倍）'],
    wick: ['盘中杀跌后拉回（下影线>1.5%）', '无长下影（下影线≤1.5%）'],
    cond: ['收盘价跌破当日均价线 + 缩量 + 股价在5日线下方',
            '集合竞价温和放量（1.2~2.5倍） + 当日缩量',
            '收盘价跌破均价线 + 收在日内最低位 + 缩量'],
  };
  Object.keys(dimChecks).forEach(dim => {
    dimChecks[dim].forEach(l => {
      assert.ok(src.includes(l), `服务端 index.js 里找不到分层文案「${l}」（维度 ${dim}）`);
    });
  });
});

check('验证表里的层名在服务端都能被检索到', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../server/index.js'), 'utf8');
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

console.log(`\n${fail === 0 ? '全部通过 ✅' : fail + ' 个失败 ❌'}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
