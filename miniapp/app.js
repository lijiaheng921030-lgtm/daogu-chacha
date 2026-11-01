const historyStore = require('./utils/history');

App({
  globalData: {
    apiBase: 'https://daogu-server-production.up.railway.app',
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
