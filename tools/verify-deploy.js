/**
 * 部署后验证脚本：确认线上后端能正常响应真实查询。
 *
 * 用法：
 *   node tools/verify-deploy.js https://daogu-chacha.onrender.com
 *   node tools/verify-deploy.js                    # 用 utils/api.js 里的 API_BASES 逐个试
 *
 * 检查项：
 *   1. /api/health 是否返回 running
 *   2. 冷启动耗时（免费版第一次请求要等容器起来）
 *   3. /api/statAnalyze 能否返回真实行情数据
 *   4. 11 个统计维度、验证统计量、Top10 新字段是否齐全
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_STOCK = process.env.STOCK_CODE || '002636';
const DEFAULT_DAYS = parseInt(process.env.DAYS || '120', 10);

function post(base, path, body, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL(path, base);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const started = Date.now();

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: payload ? 'POST' : 'GET',
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
          resolve({ ok: true, status: res.statusCode, body: parsed, raw, ms: Date.now() - started });
        });
      }
    );

    req.on('error', (e) => resolve({ ok: false, err: e.message, ms: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - started }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function verify(base) {
  console.log('\n════════════════════════════════════════');
  console.log('  验证目标: ' + base);
  console.log('════════════════════════════════════════');

  // 1. 健康检查
  console.log('\n[1/4] 健康检查 /api/health ...');
  const health = await post(base, '/api/health', null, 60000);
  if (!health.ok) {
    console.log('  ✗ 网络不通: ' + health.err);
    return { base, ok: false, stage: 'network' };
  }
  if (health.status !== 200) {
    console.log('  ✗ HTTP ' + health.status);
    return { base, ok: false, stage: 'health' };
  }
  console.log('  ✓ 服务在线，耗时 ' + health.ms + 'ms');
  console.log('    ' + (health.raw || '').slice(0, 120));

  // 2. 真实查询
  console.log('\n[2/4] 真实查询 ' + DEFAULT_STOCK + '（' + DEFAULT_DAYS + ' 交易日）...');
  const t0 = Date.now();
  const stat = await post(base, '/api/statAnalyze',
    { stock_code: DEFAULT_STOCK, days: DEFAULT_DAYS }, 120000);
  const elapsed = Date.now() - t0;

  if (!stat.ok) {
    console.log('  ✗ 请求失败: ' + stat.err + '（耗时 ' + elapsed + 'ms）');
    return { base, ok: false, stage: 'stat' };
  }
  const d = stat.body && stat.body.data ? stat.body.data : stat.body;
  if (!d || !d.stock_name) {
    console.log('  ✗ 返回异常: ' + (stat.raw || '').slice(0, 200));
    return { base, ok: false, stage: 'stat-data' };
  }

  console.log('  ✓ 查询成功，耗时 ' + elapsed + 'ms');
  console.log('    股票: ' + d.stock_name + ' (' + d.stock_code + ')');
  console.log('    区间: ' + d.data_start_date + ' ~ ' + d.data_end_date);
  console.log('    红盘 ' + d.total_red + ' 次 / 绿盘 ' + d.total_green + ' 次');

  // 3. 字段完整性
  console.log('\n[3/4] 字段完整性 ...');
  const DIMS = ['vol', 'turn', 'ma5', 'ma20', 'dist', 'cond', 'vwap', 'shape', 'auc', 'wick', 'fenshi'];
  const missing = DIMS.filter((x) => !d[x + '_stats']);
  console.log('  ' + (missing.length === 0 ? '✓' : '✗') + ' 统计维度 ' + (DIMS.length - missing.length) + '/' + DIMS.length +
    (missing.length ? '（缺: ' + missing.join(', ') + '）' : ''));

  const hasVerify = DIMS.some((x) => (d[x + '_stats'] || []).some((r) => r.v_p != null));
  console.log('  ' + (hasVerify ? '✓' : '✗') + ' 验证统计量（v_p/v_z/v_stocks）');

  const t0row = (d.top10 || [])[0] || {};
  const newFields = ['vs_ma20', 'low_shadow', 'auc_ratio'].filter((f) => t0row[f] != null);
  console.log('  ' + (newFields.length === 3 ? '✓' : '✗') + ' Top10 新字段 ' + newFields.length + '/3');

  console.log('  ' + (d.conclusions && d.conclusions.turn ? '✓' : '✗') + ' 换手率维度结论');

  // 4. 汇总
  console.log('\n[4/4] 结论');
  const allOk = missing.length === 0 && hasVerify && newFields.length === 3;
  console.log('  ' + (allOk ? '✓ 全部通过，这个后端可以直接用' : '✗ 有缺失项，需要检查后端代码版本'));
  console.log('  headline: ' + (d.headline || '').slice(0, 60));

  return { base, ok: allOk, ms: elapsed, stock: d.stock_name };
}

(async () => {
  let bases = process.argv.slice(2);
  if (!bases.length) {
    try {
      const { API_BASES } = require('../miniapp/utils/api');
      bases = API_BASES;
    } catch (e) {
      console.log('无法读取 API_BASES，请直接传入地址');
      process.exit(1);
    }
  }

  const results = [];
  for (const b of bases) {
    results.push(await verify(b));
  }

  console.log('\n════════════════════════════════════════');
  console.log('  汇总');
  console.log('════════════════════════════════════════');
  results.forEach((r) => {
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.base +
      (r.stage ? '  （失败于 ' + r.stage + '）' : '  ' + r.ms + 'ms  ' + r.stock));
  });

  const anyOk = results.some((r) => r.ok);
  console.log('\n' + (anyOk ? '✅ 有可用后端' : '❌ 没有可用后端'));
  process.exit(anyOk ? 0 : 1);
})();
