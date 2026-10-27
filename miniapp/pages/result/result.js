Page({
  data: {
    report: null,
    stock_name: '',
    stock_code: '',
    // 统计表有 8 列，屏幕放不下，横向滚动；表头和所有数据表共用同一个 scrollLeft 保证列对齐
    tblScroll: 0,
  },

  onTblScroll(e) {
    const x = e.detail.scrollLeft;
    // 只在变化足够大时回写，避免 setData → scroll-left → scroll 事件的回环
    if (Math.abs(x - this.data.tblScroll) > 1) {
      this.setData({ tblScroll: x });
    }
  },

  onLoad(options) {
    // 优先从本地缓存读取整份报告（URL 只带一个短 key，避免 query 超长）
    if (options && options.key) {
      let report = null;
      try {
        report = wx.getStorageSync(options.key);
      } catch (e) {
        console.error('读取报告缓存失败', e);
      }
      if (report && typeof report === 'object') {
        this.applyReport(report);
        // 缓存用完即清，避免占满本地空间
        try { wx.removeStorageSync(options.key); } catch (e) {}
        return;
      }
    }

    // 兼容旧路径：报告直接放在 query 里
    // 微信对 query 的解码行为在不同基础库版本间不一致（有的解一次，有的原样透传），
    // 这里两种都试，并且对解码异常做兜底，避免整页卡在 loading。
    if (options && options.data) {
      const report = this.parseReportParam(options.data);
      if (report) {
        this.applyReport(report);
        return;
      }
      console.error('解析报告数据失败');
      wx.showToast({ title: '数据解析失败', icon: 'none' });
    }
  },

  // 依次尝试：直接解析 → 解码一次 → 解码两次
  parseReportParam(raw) {
    const attempts = [raw];
    let cur = raw;
    for (let i = 0; i < 2; i++) {
      try {
        cur = decodeURIComponent(cur);
      } catch (e) {
        break; // 非法转义，说明已经解过了
      }
      attempts.push(cur);
    }
    for (const s of attempts) {
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === 'object') return obj;
      } catch (e) {}
    }
    return null;
  },

  applyReport(report) {
    this.setData({
      report: report,
      stock_name: report.stock_name || '未知股票',
      stock_code: report.stock_code || '',
    });
  },

  goBack() {
    wx.navigateBack();
  }
});
