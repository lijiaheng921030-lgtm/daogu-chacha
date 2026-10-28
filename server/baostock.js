// ============================================================================
// BaoStock 客户端（Node 版）
// ----------------------------------------------------------------------------
// 用途：取「真实分时」数据。BaoStock 提供 5/15/30/60 分钟 K 线，
//       每个交易日 48 根 5 分钟 bar（09:35~11:30 + 13:05~15:00），
//       历史可回溯到 2020 年，比 Tushare 的分钟级接口（403 无权限）实用得多。
//
// 协议：TCP 长连接 + 定长头 + zlib 压缩，细节照抄 baostock 官方 Python 包：
//   头 = 版本(00.9.30) + \x01 + 消息类型 + \x01 + 正文长度(左补零到10位)
//   包 = 头 + 正文 + \x01 + crc32(头+正文)，末尾再追加 "\n"
//   响应以 "<![CDATA[]]>\n" 结尾；压缩类型的正文用 zlib 解压
//
// 登录是匿名登录（anonymous/123456），不需要注册账号。
// ============================================================================

const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SERVER_IP = 'public-api.baostock.com';
const SERVER_PORT = 10030;
const CLIENT_VERSION = '00.9.30';
const SPLIT = '\x01';
const HEADER_LENGTH = 21;      // 版本(6) + \x01 + 类型(2) + \x01 + 长度(10) + 2 = 21
const END_MARK = Buffer.from('<![CDATA[]]>\n', 'utf8');

// 这些消息类型的正文是 zlib 压缩的
const COMPRESSED_TYPES = new Set(['96', '99', '9B', '9D']);

const MIN_FIELDS = 'date,time,code,open,high,low,close,volume,amount,adjustflag';
const DAY_FIELDS = 'date,code,open,high,low,close,volume,amount,turn,pctChg,tradestatus,isST';

function buildHeader(msgType, bodyLength) {
  return CLIENT_VERSION + SPLIT + msgType + SPLIT + String(bodyLength).padStart(10, '0');
}

// 发一帧，收一帧（按结束标记切分，不假设一次 recv 就拿全）
function frame(sock, payload) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= END_MARK.length &&
          buf.slice(buf.length - END_MARK.length).equals(END_MARK)) {
        sock.removeListener('data', onData);
        sock.removeListener('error', onError);
        resolve(buf.slice(0, buf.length - END_MARK.length));
      }
    };
    const onError = err => {
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      reject(err);
    };
    sock.on('data', onData);
    sock.on('error', onError);
    sock.write(payload);
  });
}

// 解析一帧：头 21 字节 + 正文（必要时 zlib 解压）
function parseFrame(raw) {
  if (!raw || raw.length < HEADER_LENGTH) return null;
  const head = raw.slice(0, HEADER_LENGTH).toString('utf8');
  const arr = head.split(SPLIT);
  const msgType = arr[1];
  const bodyLength = parseInt(arr[2], 10);
  let body = raw.slice(HEADER_LENGTH, HEADER_LENGTH + bodyLength);
  if (COMPRESSED_TYPES.has(msgType)) {
    try { body = zlib.inflateSync(body); }
    catch (e) { try { body = zlib.inflateRawSync(body); } catch (_) { return null; } }
  }
  return { msgType, body: body.toString('utf8') };
}

function sendMessage(sock, msgType, body) {
  const headBody = buildHeader(msgType, Buffer.byteLength(body, 'utf8')) + body;
  const crc = zlib.crc32 ? zlib.crc32(Buffer.from(headBody, 'utf8'))
                         : crc32Fallback(Buffer.from(headBody, 'utf8'));
  const payload = Buffer.from(headBody + SPLIT + String(crc) + '\n', 'utf8');
  return frame(sock, payload);
}

// Node < 20.12 没有 zlib.crc32时的兜底实现
function crc32Fallback(buf) {
  let table = crc32Fallback.table;
  if (!table) {
    table = crc32Fallback.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function connect(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: SERVER_IP, port: SERVER_PORT });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('BaoStock 连接超时'));
    }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * 打开一个已登录的 BaoStock 会话。
 * 返回 { sock, queryKData(bscode, fields, start, end, freq) } ，用完请调用 close()
 */
async function openSession(timeoutMs = 15000) {
  const sock = await connect(timeoutMs);
  const loginBody = ['login', 'anonymous', '123456', '0'].join(SPLIT);
  const res = await sendMessage(sock, '00', loginBody);
  const parsed = parseFrame(res);
  if (!parsed) { sock.destroy(); throw new Error('BaoStock 登录响应解析失败'); }
  const bodyArr = parsed.body.split(SPLIT);
  if (bodyArr[0] !== '0') {
    sock.destroy();
    throw new Error('BaoStock 登录失败: ' + (bodyArr[1] || parsed.body.slice(0, 80)));
  }
  const userId = bodyArr[2] || 'anonymous';

  async function queryKData(bscode, fields, start, end, freq, adjustflag = '2') {
    // query_history_k_data_plus + user_id + 页码 + 每页条数 + code + 字段 + 起 + 止 + 频率 + 复权
    const body = [
      'query_history_k_data_plus', userId, '1', '100000', bscode,
      fields, start, end, freq, adjustflag,
    ].join(SPLIT);
    const raw = await sendMessage(sock, '95', body);
    const p = parseFrame(raw);
    if (!p) throw new Error('BaoStock 响应解析失败');
    const arr = p.body.split(SPLIT);
    const errorCode = arr[0];
    const errorMsg = arr[1] || '';
    if (errorCode !== '0') {
      throw new Error(`BaoStock 查询失败(${errorCode}): ${errorMsg}`);
    }
    // 字段顺序见官方包：0=errCode 1=errMsg 2=method 3=user 4=page 5=perPage
    //   6=data(json) 7=code 8=fields 9=start 10=end 11=freq 12=adjustflag
    const dataJson = arr[6] || '';
    const fieldStr = arr[8] || fields;
    const rows = [];
    if (dataJson.trim()) {
      let parsedJson;
      try {
        parsedJson = JSON.parse(dataJson.split(/\s+/).join(''));
      } catch (e) {
        throw new Error('BaoStock 数据解析失败: ' + e.message);
      }
      const fs = fieldStr.split(',').map(s => s.trim());
      for (const rec of parsedJson.record || []) {
        const o = {};
        fs.forEach((f, i) => { o[f] = rec[i]; });
        rows.push(o);
      }
    }
    return rows;
  }

  async function close() {
    try { await sendMessage(sock, '02', ['logout', userId].join(SPLIT)); } catch (e) { /* 忽略登出失败 */ }
    try { sock.destroy(); } catch (e) { /* ignore */ }
  }

  return { sock, queryKData, close };
}

/** 6位代码 → BaoStock 代码（sz/sh/bj 前缀） */
function toBsCode(tsCodeOrCode) {
  const m = /^(\d{6})(?:\.(SZ|SH|BJ))?$/i.exec(String(tsCodeOrCode).trim());
  if (!m) return null;
  const code = m[1];
  let market = m[2] ? m[2].toUpperCase() : null;
  if (!market) {
    if (/^(60|68|11|5|9)/.test(code)) market = 'SH';
    else if (/^(00|30|2)/.test(code)) market = 'SZ';
    else if (/^(43|83|87|92)/.test(code)) market = 'BJ';
  }
  if (!market) return null;
  return market.toLowerCase() + '.' + code;
}

/**
 * 拉取 5 分钟线（每交易日 48 根）。返回按日分组的数组。
 * 返回 { ok, error, days: { 'YYYY-MM-DD': [{t,o,h,l,c,v,a}] }, daysList: [...] }
 *
 * adjustflag 复权口径（重要）：
 *   '2' = 前复权，'3' = 不复权。
 *   本项目的主分析用的是 Tushare `daily` 接口，那是不复权价格。
 *   所以拿 5 分钟线和日线做同一只股票、同一段区间的比较时，
 *   必须用 adjustflag='3'（不复权），否则早期日期的价格会被整体平移，
 *   「最高点出现在什么位置」「均价线走向」这些指标会算错。
 */
async function fetchMinute5(tsCode, startDate, endDate, timeoutMs = 20000, adjustflag = '3') {
  const bscode = toBsCode(tsCode);
  if (!bscode) return { ok: false, error: '股票代码格式无法识别: ' + tsCode, days: {}, daysList: [] };
  let session = null;
  try {
    session = await openSession(timeoutMs);
    const rows = await session.queryKData(bscode, MIN_FIELDS, startDate, endDate, '5', adjustflag);
    const days = {};
    for (const r of rows) {
      const d = r.date;
      if (!days[d]) days[d] = [];
      // time 形如 20260803093500000 → 取 HH:MM
      const hm = String(r.time).slice(8, 12);
      days[d].push({
        t: hm,
        o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low),
        c: parseFloat(r.close), v: parseFloat(r.volume) || 0, a: parseFloat(r.amount) || 0,
      });
    }
    // 每日的 bar 按时间排序
    const daysList = Object.keys(days).sort();
    for (const d of daysList) days[d].sort((x, y) => x.t.localeCompare(y.t));
    return { ok: true, error: null, days, daysList };
  } catch (e) {
    return { ok: false, error: e.message, days: {}, daysList: [] };
  } finally {
    if (session) await session.close();
  }
}

/** 拉取日线（不复权口径与 Tushare daily 对齐，用 adjustflag='2' 前复权） */
async function fetchDaily(tsCode, startDate, endDate, timeoutMs = 20000) {
  const bscode = toBsCode(tsCode);
  if (!bscode) return { ok: false, error: '股票代码格式无法识别: ' + tsCode, rows: [] };
  let session = null;
  try {
    session = await openSession(timeoutMs);
    const rows = await session.queryKData(bscode, DAY_FIELDS, startDate, endDate, 'd');
    return { ok: true, error: null, rows };
  } catch (e) {
    return { ok: false, error: e.message, rows: [] };
  } finally {
    if (session) await session.close();
  }
}

// ============================================================================
// 分时形态数据窗口：一次会话同时拉「5 分钟线 + 日线」，按天打包
// ----------------------------------------------------------------------------
// 为什么一次会话拉两样：每次 openSession 都要走一遍登录握手，
// 分两次就多一次握手和一次连接。
//
// 复权口径：adjustflag='2'（前复权），与研究阶段验证规则时用的口径完全一致
//   （_research/bs_fetch.py 就是用 '2' 拉的 5 分钟线和日线）。
//   要说明的是：同一天内所有价格乘的是同一个复权因子，
//   所以「最高点出现在什么位置」「均价线走向」这些形态指标对复权口径不敏感；
//   用 '2' 是为了和验证集逐位复现，而不是因为 '2' 更准。
// ============================================================================

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 6 小时

function cacheKey(tsCode, startDate, endDate) {
  return `${tsCode}_${startDate}_${endDate}`.replace(/[^\w.-]/g, '_');
}

function readCache(key) {
  try {
    const f = path.join(CACHE_DIR, key + '.json');
    if (!fs.existsSync(f)) return null;
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return null; }
}

function writeCache(key, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify(data));
  } catch (e) { /* 缓存写不进去不影响主流程 */ }
}

/**
 * 拉取一个区间的分时数据，返回按天分组的 { bars, ohlc }。
 * 返回 { ok, error, days: { 'YYYY-MM-DD': { bars:[...], ohlc:{open,high,low,close,volume,amount} } } }
 */
async function fetchFenshiWindow(tsCode, startDate, endDate, timeoutMs = 35000) {
  const bscode = toBsCode(tsCode);
  if (!bscode) return { ok: false, error: '股票代码格式无法识别: ' + tsCode, days: {} };

  const key = cacheKey(tsCode, startDate, endDate);
  const cached = readCache(key);
  if (cached) return { ok: true, error: null, days: cached, cached: true };

  const work = (async () => {
    let session = null;
    try {
      session = await openSession(timeoutMs);
      // 【必须串行，不能 Promise.all】BaoStock 的协议是「一帧一帧」顺序应答，
      // 同一个 socket 上并发发两个查询会导致两份响应被读串，
      // 表现是数据莫名其妙少一大半（之前并发时 120 天里只有 40 多天有分时）。
      const minRows = await session.queryKData(bscode, MIN_FIELDS, startDate, endDate, '5', '2');
      const dayRows = await session.queryKData(bscode, DAY_FIELDS, startDate, endDate, 'd', '2');

      const days = {};
      for (const r of minRows) {
        const d = r.date;
        if (!days[d]) days[d] = { bars: [], ohlc: null };
        // time 形如 20260803093500000 → 取 HH:MM
        const hm = String(r.time).slice(8, 12);
        days[d].bars.push({
          t: hm,
          o: parseFloat(r.open), h: parseFloat(r.high), l: parseFloat(r.low),
          c: parseFloat(r.close), v: parseFloat(r.volume) || 0, a: parseFloat(r.amount) || 0,
        });
      }
      for (const r of dayRows) {
        const d = r.date;
        if (!days[d]) days[d] = { bars: [], ohlc: null };
        days[d].ohlc = {
          open: parseFloat(r.open), high: parseFloat(r.high),
          low: parseFloat(r.low), close: parseFloat(r.close),
          volume: parseFloat(r.volume) || 0, amount: parseFloat(r.amount) || 0,
        };
      }
      // 每日 bar 按时间排序；没有日线 OHLC 的日子直接丢掉（形态判定必须用权威日线）
      Object.keys(days).forEach(d => {
        days[d].bars.sort((x, y) => x.t.localeCompare(y.t));
        if (!days[d].ohlc) delete days[d];
      });

      writeCache(key, days);
      return { ok: true, error: null, days, cached: false };
    } catch (e) {
      return { ok: false, error: e.message, days: {} };
    } finally {
      if (session) await session.close();
    }
  })();

  // 硬超时：BaoStock 的查询本身没有超时机制，卡住会把整个 HTTP 请求挂死
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('BaoStock 分时数据拉取超时')), timeoutMs);
  });
  try {
    return await Promise.race([work, guard]);
  } catch (e) {
    return { ok: false, error: e.message, days: {} };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  openSession, fetchMinute5, fetchDaily, fetchFenshiWindow,
  toBsCode, MIN_FIELDS, DAY_FIELDS,
};
