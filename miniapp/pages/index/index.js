const app = getApp();
const { deriveVerdict } = require('../../utils/verdict');
const historyStore = require('../../utils/history');

// 后端要拉 5 分钟线 + 做跨股票检验，给足超时时间
const REQUEST_TIMEOUT = 60000;

Page({
  data: {
    stockInput: '',
    loading: false,
    errorMsg: '',
    // 出错时展示「重试」按钮
    canRetry: false,
    daysOptions: [
      { label: '120个交易日', value: 120 },
      { label: '60个交易日', value: 60 },
      { label: '30个交易日', value: 30 },
    ],
    selectedDays: { label: '120个交易日', value: 120 },
    // 快捷入口：默认几只常见票，后续可按用户历史动态替换
    quickStocks: [
      { code: '000733', name: '振华科技' },
      { code: '002475', name: '立讯精密' },
      { code: '600267', name: '振华股份' },
      { code: '600519', name: '贵州茅台' }
    ],
  },

  onLoad() {
    // 上次会话如果中途退出，可能留下没有被任何历史条目引用的报告缓存
    historyStore.cleanOrphanReports();
  },

  onDaysChange(e) {
    const idx = e.detail.value;
    const option = this.data.daysOptions[idx];
    if (option) this.setData({ selectedDays: option });
  },

  onInput(e) {
    // 有错误提示时用户开始改输入，说明他看到了，直接清掉提示
    this.setData({ stockInput: e.detail.value, errorMsg: '', canRetry: false });
  },

  onQuickSelect(e) {
    const code = e.currentTarget.dataset.code;
    if (this.data.loading) return;
    this.setData({ stockInput: code, errorMsg: '', canRetry: false });
    this.doSearch(code);
  },

  onSearch() {
    // loading 时直接返回，防止并发请求导致结果错乱
    if (this.data.loading) return;

    const input = (this.data.stockInput || '').trim();
    if (!input) {
      this.setData({ errorMsg: '请输入股票代码或名称', canRetry: false });
      return;
    }
    this.doSearch(input);
  },

  onRetry() {
    this.onSearch();
  },

  doSearch(keyword) {
    if (this.data.loading) return;
    this.setData({ loading: true, errorMsg: '', canRetry: false });

    wx.request({
      url: `${app.globalData.apiBase}/api/statAnalyze`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { stock_code: keyword, days: this.data.selectedDays.value },
      timeout: REQUEST_TIMEOUT,
      success: (res) => {
        this.setData({ loading: false });

        // 后端异常时可能返回非对象或空 body，先兜底
        const body = res.data;
        if (!body || typeof body !== 'object') {
          this.setData({
            errorMsg: '服务器返回异常，请稍后重试',
            canRetry: true
          });
          return;
        }

        if (body.code === 0 && body.data) {
          this.handleSuccess(body.data);
        } else {
          this.setData({
            errorMsg: this.formatError(body.code, body.msg),
            canRetry: true
          });
        }
      },
      fail: (err) => {
        this.setData({ loading: false });
        console.error('请求失败', err);
        const msg = (err && err.errMsg) || '';
        if (/timeout/i.test(msg)) {
          this.setData({
            errorMsg: '分析超时（超过60秒），数据量较大的股票需要更久，请重试',
            canRetry: true
          });
        } else {
          this.setData({
            errorMsg: '网络请求失败，请检查网络后重试',
            canRetry: true
          });
        }
      }
    });
  },

  // 按后端错误码给出可操作的提示，而不是笼统的「查询失败」
  formatError(code, msg) {
    switch (code) {
      case 400:
        return msg || '请求参数有误，请重试';
      case 404:
        return msg || '未找到该股票，请检查代码或名称';
      case 502:
        return msg || '数据源暂时不可用，请稍后重试';
      case 500:
        return msg || '服务器内部错误，请稍后重试';
      default:
        return msg || '查询失败，请检查股票代码';
    }
  },

  handleSuccess(report) {
    // 先落历史（含完整报告），拿到 reportKey 后直接用它做页面跳转参数，
    // 这样历史条目和结果页共用同一份缓存，不会产生孤儿键。
    let entry;
    try {
      const verdictInfo = deriveVerdict(report);
      entry = historyStore.addEntry(report, verdictInfo);
    } catch (e) {
      console.error('保存历史失败', e);
    }

    let navKey = (entry && entry.reportKey) || '';

    // 报告过大导致历史降级为「只存摘要」时，这里再单独缓存一份临时报告给结果页用
    if (!navKey) {
      navKey = `daogu_tmp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      try {
        wx.setStorageSync(navKey, report);
      } catch (e) {
        console.error('缓存报告失败', e);
        this.setData({
          errorMsg: '报告缓存失败，请重试',
          canRetry: true
        });
        return;
      }
    }

    wx.navigateTo({
      url: `/pages/result/result?key=${navKey}`,
      fail: (err) => {
        // 跳转失败要清掉刚建的临时缓存，避免留下孤儿数据
        if (navKey.indexOf('daogu_tmp_') === 0) {
          try { wx.removeStorageSync(navKey); } catch (e) {}
        }
        this.setData({
          errorMsg: '打开结果页失败：' + ((err && err.errMsg) || ''),
          canRetry: true
        });
      }
    });
  },

  goHistory() {
    // 历史页是 tabBar 页面，必须用 switchTab，不能用 navigateTo
    wx.switchTab({ url: '/pages/history/history' });
  }
});
