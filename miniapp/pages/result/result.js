const historyStore = require('../../utils/history');
const { enrichReport } = require('../../utils/report');

Page({
  data: {
    report: null,
    stock_name: '',
    stock_code: '',
    // 报告加载失败时的兜底提示
    loadFailed: false,
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
        // 注意：这里不能删缓存。
        // 报告缓存与历史记录条目共享同一份数据（daogu_report_<ts>），
        // 删掉会导致「历史记录」里再点开这条时报告已失效。
        // 孤儿缓存由 utils/history.js 的 cleanOrphanReports() 统一清理。
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
    }

    // 走到这里说明既没拿到缓存也没拿到 query 数据，不能一直停在 loading
    this.setData({ loadFailed: true });
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
      report: enrichReport(report),
      stock_name: report.stock_name || '未知股票',
      stock_code: report.stock_code || '',
      loadFailed: false,
    });
  },

  // 分享给好友/转发到会话
  onShareAppMessage() {
    const r = this.data.report;
    const name = (r && r.stock_name) || '个股';
    const headline = (r && r.headline) || '次日红绿盘统计分析';
    return {
      title: `${name}｜${headline}`,
      path: '/pages/index/index',
      imageUrl: '/images/rice.png'
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    const r = this.data.report;
    const name = (r && r.stock_name) || '个股';
    return {
      title: `稻谷查查：${name} 次日红绿盘统计分析`,
      query: '',
      imageUrl: '/images/rice.png'
    };
  },

  goBack() {
    wx.navigateBack({
      fail: () => {
        // 结果页可能被直接打开（没有上一页栈），回退到首页
        wx.switchTab({ url: '/pages/index/index' });
      }
    });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
