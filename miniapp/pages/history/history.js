const app = getApp();

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
      const history = wx.getStorageSync(app.globalData.historyKey) || [];
      this.setData({ history, loading: false });
    } catch (e) {
      this.setData({ history: [], loading: false });
    }
  },

  onClear() {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有历史记录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync(app.globalData.historyKey);
          this.setData({ history: [] });
        }
      }
    });
  }
});
