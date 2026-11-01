/**
 * 历史记录存储。
 *
 * 设计：
 *   - 列表存在 historyKey 下（最多 10 条，新的在前）
 *   - 每条分析的完整报告单独存在 REPORT_PREFIX + ts 下
 *     这样点开历史条目能重新看完整报告，而不是只能看一行字。
 *   - 报告体积有上限（十几 KB），超出时退化为「只存摘要」，
 *     保证历史列表永远不会因为单条超大而写失败。
 */

const HISTORY_KEY = 'daogu_history';
const REPORT_PREFIX = 'daogu_report_';
const MAX_HISTORY = 10;
const MAX_REPORT_BYTES = 100 * 1024; // 单条报告上限 100KB

/**
 * 生成唯一 ID。
 *
 * 注意：不能直接用 Date.now()——它只有毫秒精度，连续添加两条时会撞车，
 * 导致两条历史共用同一个 reportKey，删掉一条会连带删掉另一条的报告缓存。
 * 这里用「时间戳 + 自增序号 + 随机数」保证唯一，同时用字符串类型
 * （WXML dataset 取到的值都是字符串，字符串比较不会出现类型不一致的问题）。
 */
let idSeq = 0;
function nextId() {
  idSeq += 1;
  return `${Date.now()}_${idSeq}_${Math.floor(Math.random() * 100000)}`;
}

function getList() {
  try {
    const list = wx.getStorageSync(HISTORY_KEY);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('读取历史失败', e);
    return [];
  }
}

function setList(list) {
  try {
    wx.setStorageSync(HISTORY_KEY, list);
    return true;
  } catch (e) {
    console.error('写入历史失败', e);
    return false;
  }
}

function reportKey(ts) {
  return REPORT_PREFIX + ts;
}

/** 清理没有任何历史条目引用的孤儿报告缓存 */
function cleanOrphanReports() {
  try {
    const info = wx.getStorageInfoSync();
    const keys = (info && info.keys) || [];
    const used = {};
    getList().forEach((it) => {
      if (it && it.reportKey) used[it.reportKey] = true;
    });
    keys.forEach((k) => {
      if (k.indexOf(REPORT_PREFIX) === 0 && !used[k]) {
        try { wx.removeStorageSync(k); } catch (e) {}
      }
    });
  } catch (e) {
    console.error('清理孤儿缓存失败', e);
  }
}

/**
 * 保存一条历史。
 * @param {object} report 完整报告
 * @param {object} verdictInfo { verdict, verdictText, detail }
 */
function addEntry(report, verdictInfo) {
  const ts = nextId();
  const key = reportKey(ts);

  // 先尝试存完整报告，失败/超限则只存摘要
  let full = false;
  try {
    const payload = JSON.stringify(report);
    if (payload.length <= MAX_REPORT_BYTES) {
      wx.setStorageSync(key, report);
      full = true;
    }
  } catch (e) {
    console.error('缓存报告失败，降级为摘要', e);
  }

  const entry = {
    ts: ts,
    stock_name: (report && report.stock_name) || '',
    stock_code: (report && report.stock_code) || '',
    days: (report && report.days) || 0,
    verdict: verdictInfo.verdict,
    verdict_text: verdictInfo.verdictText,
    verdict_detail: verdictInfo.detail,
    headline: (report && report.headline) || '',
    date: new Date().toLocaleDateString('zh-CN'),
    reportKey: full ? key : ''  // 空串表示报告过大/缓存失败，只能看摘要
  };

  const list = getList();
  list.unshift(entry);

  // 超量时，从最旧的开始删，同时清掉它引用的报告缓存
  while (list.length > MAX_HISTORY) {
    const dropped = list.pop();
    if (dropped && dropped.reportKey) {
      try { wx.removeStorageSync(dropped.reportKey); } catch (e) {}
    }
  }

  // 列表写失败（配额满等）不能影响主流程，返回 null 让调用方知道没存上
  if (!setList(list)) {
    if (entry.reportKey) {
      try { wx.removeStorageSync(entry.reportKey); } catch (e) {}
    }
    return null;
  }
  return entry;
}

/** 删除单条 */
function removeEntry(ts) {
  const list = getList();
  const idx = list.findIndex((it) => it && it.ts === ts);
  if (idx === -1) return false;
  const [dropped] = list.splice(idx, 1);
  if (dropped && dropped.reportKey) {
    try { wx.removeStorageSync(dropped.reportKey); } catch (e) {}
  }
  setList(list);
  return true;
}

/** 清空全部（含报告缓存） */
function clearAll() {
  const list = getList();
  list.forEach((it) => {
    if (it && it.reportKey) {
      try { wx.removeStorageSync(it.reportKey); } catch (e) {}
    }
  });
  try { wx.removeStorageSync(HISTORY_KEY); } catch (e) {}
}

module.exports = {
  HISTORY_KEY,
  REPORT_PREFIX,
  MAX_HISTORY,
  getList,
  addEntry,
  removeEntry,
  clearAll,
  cleanOrphanReports,
  reportKey
};
