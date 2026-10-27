// Tushare 代理调用封装
// 代理 https://t.xiaodefa.top/ 存在两个不稳定因素:
//   1) 并发/多 IP 使用会返回 code=500 "ip超限，请不到在多个ip同时使用"
//   2) 偶发返回 code=429 "请开启gzip"
// 两种情况都是瞬时故障，需要重试 + 退避，否则上层会误判成"股票停牌"。

const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || '408d073d81acebc8bc76faa303be7de7d0067343625bc2fcc9869aea';
const TUSHARE_URL = process.env.TUSHARE_URL || 'https://t.xiaodefa.top/';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 可重试的错误：限流 / gzip 要求 / 网关抖动
function isTransient(code, msg) {
  if (code === 429) return true;
  if (code === 500 && /ip超限|gzip|多个ip/i.test(msg || '')) return true;
  if (code === 502 || code === 503 || code === 504) return true;
  return false;
}

/**
 * 调用 Tushare 代理，返回 {ok, code, msg, rows:[对象数组], fields:[...]}
 */
async function tushareCall(apiName, params, opts = {}) {
  const maxRetry = opts.maxRetry ?? 4;
  const baseDelay = opts.baseDelay ?? 1200;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      const resp = await fetch(TUSHARE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 代理要求客户端声明支持 gzip
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify({ api_name: apiName, token: TUSHARE_TOKEN, params }),
      });
      const text = await resp.text();
      const result = JSON.parse(text);

      if (result.code === 0 && result.data && Array.isArray(result.data.items)) {
        const fields = result.data.fields || [];
        const rows = result.data.items.map(row => {
          const obj = {};
          fields.forEach((f, i) => { obj[f] = row[i]; });
          return obj;
        });
        return { ok: true, code: 0, msg: '', rows, fields };
      }

      // 接口本身不存在（如 50101）→ 不重试
      if (!isTransient(result.code, result.msg)) {
        return { ok: false, code: result.code, msg: result.msg || '', rows: [], fields: [] };
      }
      lastErr = { code: result.code, msg: result.msg || '' };
    } catch (e) {
      lastErr = { code: -1, msg: e.message };
    }

    if (attempt < maxRetry) {
      // 指数退避 + 抖动
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
      await sleep(delay);
    }
  }

  console.error(`[tushare] ${apiName} 失败: code=${lastErr?.code} msg=${lastErr?.msg}`);
  return { ok: false, code: lastErr?.code ?? -1, msg: lastErr?.msg || '请求失败', rows: [], fields: [] };
}

/**
 * 取日K。失败时自动放宽时间范围重试（新股/停牌股数据不足）。
 */
async function fetchKline(thscode, startDate, endDate) {
  const r = await tushareCall('daily', { ts_code: thscode, start_date: startDate, end_date: endDate });
  return r.ok ? r.rows : null;
}

/** 取每日基本面指标（真实换手率 / 量比 / 市值） */
async function fetchDailyBasic(thscode, startDate, endDate) {
  const r = await tushareCall('daily_basic', { ts_code: thscode, start_date: startDate, end_date: endDate });
  return r.ok ? r.rows : [];
}

/** 取集合竞价（真实盘口分时数据） */
async function fetchAuction(thscode, startDate, endDate) {
  const r = await tushareCall('stk_auction', { ts_code: thscode, start_date: startDate, end_date: endDate });
  return r.ok ? r.rows : [];
}

/** 取资金流向（分单大小） */
async function fetchMoneyflow(thscode, startDate, endDate) {
  const r = await tushareCall('moneyflow', { ts_code: thscode, start_date: startDate, end_date: endDate });
  return r.ok ? r.rows : [];
}

/** 按 trade_date 建索引，便于与日K对齐 */
function byDate(rows) {
  const m = {};
  (rows || []).forEach(r => { m[r.trade_date] = r; });
  return m;
}

/**
 * 查询股票（数字代码或中文名），返回 {ts_code, name} 或 null
 */
async function searchStock(keyword) {
  const szPrefixes = ['000', '002', '300'];
  const mk = code => (szPrefixes.includes(code.slice(0, 3)) ? `${code}.SZ` : `${code}.SH`);

  const tryPayload = async params => {
    const r = await tushareCall('stock_basic', params, { maxRetry: 3 });
    if (r.ok && r.rows.length > 0) {
      return { ts_code: r.rows[0].ts_code, name: r.rows[0].name };
    }
    return null;
  };

  if (/^\d{6}$/.test(keyword)) {
    // 数字代码：先按 ts_code 精确查（能同时拿到公司名）
    const byCode = await tryPayload({ ts_code: mk(keyword), name: '', list_status: 'L' });
    if (byCode) return byCode;
  }

  // 中文名搜索：ts_code 传空串有时会被代理拒（50101），省略该键更稳
  const byName = await tryPayload({ name: keyword, list_status: 'L' });
  if (byName) return byName;

  // 兜底：不限上市状态
  return await tryPayload({ name: keyword });
}

module.exports = { tushareCall, fetchKline, fetchDailyBasic, fetchAuction, fetchMoneyflow, byDate, searchStock, TUSHARE_URL, TUSHARE_TOKEN };
