Page({
  data: {
    report: null,
    stock_name: '',
    stock_code: '',
  },

  onLoad(options) {
    if (options.data) {
      try {
        const report = JSON.parse(decodeURIComponent(options.data));
        this.setData({
          report: report,
          stock_name: report.stock_name || '未知股票',
          stock_code: report.stock_code || '',
        });
      } catch (e) {
        console.error('解析报告数据失败', e);
        wx.showToast({ title: '数据解析失败', icon: 'none' });
      }
    }
  },

  goBack() {
    wx.navigateBack();
  }
});
