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
          // 报告可能十几 KB，URL query 上限约 1024 字符，装不下。
          // 存本地缓存，只把短 key 传给结果页。
          const reportKey = `report_${Date.now()}`;
          try {
            wx.setStorageSync(reportKey, res.data.data);
          } catch (e) {
            console.error('缓存报告失败', e);
            this.setData({ loading: false, errorMsg: '报告缓存失败，请重试' });
            return;
          }
          wx.navigateTo({
            url: `/pages/result/result?key=${reportKey}`,
            fail: (err) => {
              this.setData({ loading: false, errorMsg: '打开结果页失败：' + (err.errMsg || '') });
            }
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
        stock_code: report.stock_code || '',
        // statAnalyze 的报告没有 A/B/C 裁决字段，用一句话结论当徽章文案
        verdict: 'C',
        verdict_text: report.headline || '分析完成',
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
