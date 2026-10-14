const app = getApp();

Page({
  data: {
    stockInput: '',
    loading: false,
    errorMsg: '',
    daysOptions: [
      { label: '120个交易日', value: 120 },
      { label: '60个交易日', value: 60 },
      { label: '30个交易日', value: 30 },
    ],
    selectedDays: { label: '120个交易日', value: 120 },
  },

  onDaysChange(e) {
    const idx = e.detail.value;
    const option = this.data.daysOptions[idx];
    this.setData({ selectedDays: option });
  },

  onInput(e) {
    this.setData({ stockInput: e.detail.value, errorMsg: '' });
  },

  onQuickSelect(e) {
    const code = e.currentTarget.dataset.code;
    this.setData({ stockInput: code, errorMsg: '' });
    this.doSearch(code);
  },

  onSearch() {
    const input = this.data.stockInput.trim();
    if (!input) {
      this.setData({ errorMsg: '请输入股票代码或名称' });
      return;
    }
    this.doSearch(input);
  },

  doSearch(keyword) {
    this.setData({ loading: true, errorMsg: '' });

    wx.request({
      url: `${app.globalData.apiBase}/api/statAnalyze`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { stock_code: keyword, days: this.data.selectedDays.value },
      success: (res) => {
        this.setData({ loading: false });
        if (res.data.code === 0) {
          this.saveHistory(res.data.data);
          wx.navigateTo({
            url: `/pages/result/result?data=${encodeURIComponent(JSON.stringify(res.data.data))}`
          });
        } else {
          this.setData({ errorMsg: res.data.msg || '查询失败，请检查股票代码' });
        }
      },
      fail: (err) => {
        this.setData({ loading: false, errorMsg: '网络请求失败，请检查服务器是否启动' });
        console.error(err);
      }
    });
  },

  saveHistory(report) {
    try {
      const history = wx.getStorageSync(app.globalData.historyKey) || [];
      const entry = {
        stock_name: report.stock_name || this.data.stockInput,
        verdict: report.verdict,
        verdict_text: report.verdict_text,
        date: new Date().toLocaleDateString('zh-CN'),
        ts: Date.now(),
      };
      history.unshift(entry);
      if (history.length > 10) history.pop();
      wx.setStorageSync(app.globalData.historyKey, history);
    } catch (e) {
      console.error('保存历史失败', e);
    }
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  }
});
