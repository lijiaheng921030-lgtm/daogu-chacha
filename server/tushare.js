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
  // 代理可能把限流换成 403 + "ip超限" 之类的措辞，按文本再兜一层
  if ((code === 403 || code === 429) && /ip超限|gzip|多个ip|限流|频繁/i.test(msg || '')) return true;
  return false;
}

// 权限/令牌类错误：重试没有意义，必须立刻返回，让上层给出准确提示
function isAuthError(code, msg) {
  if (code === 2002) return true;                       // token 不对 / 过期
  if (code === 403 && /权限|管理员/.test(msg || '')) return true;
  if (code === 50101) return true;                      // 接口名不存在（多为权限未开通）
  return false;
}

/**
 * 调用 Tushare 代理，返回 {ok, code, msg, rows:[对象数组], fields:[...]}
 */
async function tushareCall(apiName, params, opts = {}) {
  const maxRetry = opts.maxRetry ?? 4;
  const baseDelay = opts.baseDelay ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 15000;
  // 整个调用的总预算（含退避），避免一次失败把用户请求拖到小程序 60 秒超时之后
  const totalBudgetMs = opts.totalBudgetMs ?? 40000;
  const startedAt = Date.now();
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (Date.now() - startedAt > totalBudgetMs) {
      lastErr = { code: lastErr?.code ?? -1, msg: '重试超时' };
      break;
    }
    try {
      // 单次请求超时控制：代理 accept 后不响应时不能让请求一直挂着
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetch(TUSHARE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 代理要求客户端声明支持 gzip
            'Accept-Encoding': 'gzip, deflate',
          },
          body: JSON.stringify({ api_name: apiName, token: TUSHARE_TOKEN, params }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
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

      // 权限/令牌问题 → 不重试
      if (isAuthError(result.code, result.msg)) {
        return { ok: false, code: result.code, msg: result.msg || '', rows: [], fields: [] };
      }
      // 接口本身不存在（如 50101）→ 不重试
      if (!isTransient(result.code, result.msg)) {
        return { ok: false, code: result.code, msg: result.msg || '', rows: [], fields: [] };
      }
      lastErr = { code: result.code, msg: result.msg || '' };
    } catch (e) {
      // 超时/网络中断属于瞬时故障，可重试
      lastErr = { code: -1, msg: e.message };
    }

    if (attempt < maxRetry) {
      // 指数退避 + 抖动（受总预算约束）
      const delay = Math.min(baseDelay * Math.pow(2, attempt), 4000) + Math.floor(Math.random() * 400);
      if (Date.now() - startedAt + delay > totalBudgetMs) break;
      await sleep(delay);
    }
  }

  console.error(`[tushare] ${apiName} 失败: code=${lastErr?.code} msg=${lastErr?.msg}`);
  return { ok: false, code: lastErr?.code ?? -1, msg: lastErr?.msg || '请求失败', rows: [], fields: [] };
}

/**
 * 取日K。返回 {ok, rows, code, msg}，让上层能区分"停牌"和"token失效/无权限"。
 */
async function fetchKline(thscode, startDate, endDate) {
  const r = await tushareCall('daily', { ts_code: thscode, start_date: startDate, end_date: endDate });
  return { ok: r.ok, rows: r.ok ? r.rows : [], code: r.code, msg: r.msg };
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
