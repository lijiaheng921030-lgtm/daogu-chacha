// 模拟微信小程序运行时，验证 首页 → 结果页 的数据流
const fs = require('fs');
let FAIL = 0;
const ok = (c, m) => { console.log((c ? '✅' : '❌') + ' ' + m); if (!c) FAIL++; };

// ---- 模拟 wx 全局 ----
const store = {};
global.wx = {
  getStorageSync: k => store[k],
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: k => { delete store[k]; },
  request: null,
  navigateTo: null,
  showToast: o => console.log('   [toast]', o.title),
  getApp: () => global.__app,
};
global.getApp = () => global.__app;
global.__app = { globalData: { apiBase: 'http://x', historyKey: 'daogu_history' } };

// ---- 载入 index.js 和 result.js（它们引用 getApp / Page）----
function loadPage(file) {
  let page = null;
  global.Page = p => { page = p; };
  const src = fs.readFileSync(file, 'utf8');
  new Function(src)();
  // 注入 setData
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function (o) { Object.assign(this.data, o); };
  return page;
}

const report = { stock_name: '澳洋健康', stock_code: '002172.SZ', headline: '成功率最高：X（81.8%）',
  vol_stats: [{label:'A',red_count:36,red_ratio:'31.9',red_avg:'4.03',green_count:39,green_ratio:'34.5',green_avg:'-2.29',sample_count:75,layer_rate:'48.0'}],
  conclusions: { vol: 'X' } };

console.log('=== 1) 首页跳转：报告写入缓存，URL 只带短 key ===');
const index = loadPage(__dirname + '/../miniapp/pages/index/index.js');
let navUrl = null;
wx.navigateTo = o => { navUrl = o.url; };
wx.request = o => { o.success({ data: { code: 0, data: report } }); };
index.doSearch('002172');
ok(!!navUrl, '触发了 navigateTo');
ok(navUrl && navUrl.length < 200, `URL 长度 ${navUrl ? navUrl.length : 0} 字符 (<1024 上限)`);
ok(navUrl && navUrl.includes('key=report_'), 'URL 使用 key 参数');
const key = navUrl.split('key=')[1];
ok(!!store[key], '报告已写入本地缓存');
ok(store['daogu_history'] && store['daogu_history'][0].stock_name === '澳洋健康', '历史记录已保存');
ok(store['daogu_history'][0].verdict_text === report.headline, '历史徽章文案 = headline（非空）');

console.log('\n=== 2) 结果页：从 key 读取报告 ===');
const result = loadPage(__dirname + '/../miniapp/pages/result/result.js');
result.onLoad({ key });
ok(result.data.report !== null, 'report 已加载');
ok(result.data.report.stock_name === '澳洋健康', 'stock_name 正确');
ok(!store[key], '缓存用完即清理');

console.log('\n=== 3) 结果页：兼容旧的 data= 传参（含已解码/未解码两种）===');
{
  const r2 = loadPage(__dirname + '/../miniapp/pages/result/result.js');
  r2.onLoad({ data: JSON.stringify(report) });
  ok(r2.data.report !== null, '未编码的 JSON 也能解析');
}
{
  const r2 = loadPage(__dirname + '/../miniapp/pages/result/result.js');
  r2.onLoad({ data: encodeURIComponent(JSON.stringify(report)) });
  ok(r2.data.report !== null, '编码一次的也能解析');
}
{
  const r2 = loadPage(__dirname + '/../miniapp/pages/result/result.js');
  r2.onLoad({ data: encodeURIComponent(encodeURIComponent(JSON.stringify(report))) });
  ok(r2.data.report !== null, '编码两次的也能解析');
}
{
  const r2 = loadPage(__dirname + '/../miniapp/pages/result/result.js');
  r2.onLoad({ data: '%%%not-json%%%' });
  ok(r2.data.report === null, '非法数据不崩溃，保持 null');
}

console.log('\n=== 4) 横向滚动同步 ===');
const r3 = loadPage(__dirname + '/../miniapp/pages/result/result.js');
r3.onTblScroll({ detail: { scrollLeft: 120 } });
ok(r3.data.tblScroll === 120, '滚动位置已记录');
r3.onTblScroll({ detail: { scrollLeft: 120.5 } });
ok(r3.data.tblScroll === 120, '微小变化不触发回写（防回环）');

console.log(FAIL === 0 ? '\n全部通过 ✅' : `\n${FAIL} 项失败 ❌`);
process.exit(FAIL ? 1 : 0);
