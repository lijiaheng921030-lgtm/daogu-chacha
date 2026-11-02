/**
 * 后端请求统一封装。
 *
 * 解决三个实际问题：
 *
 * 1. 多后端回退
 *    生产环境可能同时挂着 Render、Railway 等多个后端地址，
 *    任意一个挂掉/过期都不该让用户看到"网络错误"。
 *    这里按顺序尝试，第一个失败自动换下一个。
 *
 * 2. 冷启动预热
 *    Render 免费版 15 分钟无请求就休眠，下次请求要先花 30 秒把容器唤醒。
 *    而一次统计查询本身就要 40~50 秒，两者叠加会超过小程序
 *    wx.request 的 60 秒上限。
 *    所以先发一个轻量的 /api/health 把服务叫醒（这个请求会等待冷启动完成），
 *    再发真正的统计请求 —— 两次请求各自都不超 60 秒。
 *
 * 3. 错误分级
 *    「服务没起来」和「查无此股」要区别对待，用户该采取的行动完全不同：
 *    前者重试有意义，后者重试没用。
 */

// 按优先级排列的后端地址。第一个是当前主力。
// 部署新后端后把新地址放最前面，旧的留作兜底。
const API_BASES = [
  'https://daogu-server-production.up.railway.app',
  'https://daogu-chacha.onrender.com',
];

// 单次请求超时（微信 wx.request 上限就是 60 秒）
const REQUEST_TIMEOUT = 60000;
// 冷启动预热单独给一个稍长的预算：唤醒本身可能要 30 秒以上
const WARMUP_TIMEOUT = 55000;

/**
 * 发起一次裸请求，返回 Promise（不抛异常，失败时 resolve 成 {ok:false}）
 */
function rawRequest(base, path, method, data, timeout) {
  return new Promise((resolve) => {
    wx.request({
      url: base + path,
      method,
      header: { 'Content-Type': 'application/json' },
      data,
      timeout,
      success: (res) => {
        const body = res.data;
        if (!body || typeof body !== 'object') {
          resolve({ ok: false, reason: 'bad-body', msg: '服务器返回异常' });
          return;
        }
        resolve({ ok: true, status: res.statusCode, body });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        resolve({
          ok: false,
          reason: /timeout/i.test(msg) ? 'timeout' : 'network',
          msg
        });
      }
    });
  });
}

/**
 * 预热后端：请求 /api/health。
 *
 * 服务已热时几百毫秒就返回；服务在休眠时会等到容器启动完（约 30 秒）。
 * 这一步的等待不计入统计查询的超时预算。
 *
 * @returns {Promise<boolean>} 后端是否可用
 */
function warmup(base) {
  return rawRequest(base, '/api/health', 'GET', undefined, WARMUP_TIMEOUT).then((r) => {
    return !!(r.ok && r.status >= 200 && r.status < 300);
  });
}

/**
 * 带多后端回退的业务请求。
 *
 * 流程：
 *   对每个后端地址 → 先预热 → 再发业务请求
 *   业务请求失败（网络错误/超时/5xx）就换下一个后端
 *   全部失败则 reject，由调用方给出用户可理解的提示
 *
 * @param {string} path      接口路径，如 '/api/statAnalyze'
 * @param {object} data      请求体
 * @param {object} opts      { method, timeout }
 * @returns {Promise<object>} 后端返回的 body（业务错误也照常返回，由调用方判断 code）
 */
function request(path, data, opts = {}) {
  const method = opts.method || 'POST';
  const timeout = opts.timeout || REQUEST_TIMEOUT;

  let lastErr = null;

  // 依次尝试各个后端（用递归代替 async/await，兼容更老的基础库）
  function tryAt(index) {
    if (index >= API_BASES.length) {
      const e = new Error('所有后端均不可用');
      e.code = 'ALL_BASES_FAILED';
      e.detail = lastErr;
      return Promise.reject(e);
    }

    const base = API_BASES[index];

    // 预热失败说明这个后端彻底不可用，直接换下一个，
    // 不必再浪费 50 秒去发业务请求
    return warmup(base).then((alive) => {
      if (!alive) {
        lastErr = { reason: 'down', base };
        return tryAt(index + 1);
      }

      return rawRequest(base, path, method, data, timeout).then((r) => {
        if (!r.ok) {
          lastErr = { reason: r.reason, base };
          return tryAt(index + 1);
        }

        // HTTP 层错误（5xx）视为该后端故障，换下一个
        if (r.status >= 500) {
          lastErr = { reason: 'server-error', base, status: r.status };
          return tryAt(index + 1);
        }

        // 业务错误（404 查无此股、参数错误等）直接交给调用方处理，
        // 换后端也没意义 —— 数据层面的错误不是后端挂掉
        return r.body;
      });
    });
  }

  return tryAt(0);
}

module.exports = { request, warmup, API_BASES, REQUEST_TIMEOUT };
