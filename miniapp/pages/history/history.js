const historyStore = require('../../utils/history');

Page({
  data: {
    history: [],
    loading: true,
  },

  onShow() {
    this.loadHistory();
  },

  loadHistory() {
    this.setData({ loading: true });
    try {
      const history = historyStore.getList();
      this.setData({ history, loading: false });
    } catch (e) {
      console.error('读取历史失败', e);
      this.setData({ history: [], loading: false });
    }
  },

  // 点条目重新打开当时的完整报告
  onOpenItem(e) {
    const ts = e.currentTarget.dataset.ts;
    const entry = this.data.history.find((it) => it && it.ts === ts);
    if (!entry) return;

    if (!entry.reportKey) {
      // 报告过大未缓存，或缓存已丢失，只能看摘要
      wx.showModal({
        title: entry.stock_name || '分析结果',
        content: (entry.verdict_detail ? entry.verdict_detail + '\n\n' : '') + (entry.headline || '该次分析的详细报告已不在缓存中，请重新查询。'),
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }

    let report = null;
    try {
      report = wx.getStorageSync(entry.reportKey);
    } catch (e) {
      console.error('读取报告缓存失败', e);
    }

    if (!report || typeof report !== 'object') {
      wx.showToast({ title: '报告缓存已失效，请重新查询', icon: 'none' });
      // 缓存没了就把这条记录里的 reportKey 清掉，避免下次再点还是失败
      try {
        const list = historyStore.getList();
        const target = list.find((it) => it && it.ts === ts);
        if (target) {
          target.reportKey = '';
          wx.setStorageSync(historyStore.HISTORY_KEY, list);
          this.setData({ history: list });
        }
      } catch (e) {}
      return;
    }

    wx.navigateTo({
      url: `/pages/result/result?key=${entry.reportKey}`,
      fail: (err) => {
        wx.showToast({ title: '打开失败：' + ((err && err.errMsg) || ''), icon: 'none' });
      }
    });
  },

  // 删除单条
  onDeleteItem(e) {
    const ts = e.currentTarget.dataset.ts;
    const entry = this.data.history.find((it) => it && it.ts === ts);
    if (!entry) return;

    wx.showModal({
      title: '删除记录',
      content: `确定删除「${entry.stock_name || '这条记录'}」的分析记录吗？`,
      confirmText: '删除',
      confirmColor: '#E94560',
      success: (res) => {
        if (!res.confirm) return;
        historyStore.removeEntry(ts);
        this.setData({ history: historyStore.getList() });
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  onClear() {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有历史记录吗？此操作不可撤销。',
      confirmText: '清空',
      confirmColor: '#E94560',
      success: (res) => {
        if (!res.confirm) return;
        historyStore.clearAll();
        this.setData({ history: [] });
        wx.showToast({ title: '已清空', icon: 'success' });
      }
    });
  }
});
