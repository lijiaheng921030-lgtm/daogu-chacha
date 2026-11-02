const historyStore = require('./utils/history');
const { API_BASES } = require('./utils/api');

App({
  globalData: {
    // 后端地址清单（按优先级）。实际请求由 utils/api.js 负责：
    // 依次尝试、失败自动回退，并在请求前先预热以应对冷启动。
    // 保留在这里只是为了方便全局读取和调试。
    apiBases: API_BASES,
    historyKey: historyStore.HISTORY_KEY,
  },

  onLaunch() {
    // 清理上次会话残留的孤儿报告缓存（中途退出小程序会留下）
    historyStore.cleanOrphanReports();

    // 全局错误兜底，避免白屏无提示
    wx.onError((err) => {
      console.error('[稻谷查查] 未捕获异常:', err);
    });
    wx.onUnhandledRejection((res) => {
      console.error('[稻谷查查] 未处理的 Promise 拒绝:', res);
    });
  }
});
