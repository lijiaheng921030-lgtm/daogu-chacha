/**
 * 把结果页 WXML 渲染成 HTML 预览，用于离线检查排版效果。
 * 用法：node tools/render-preview.js > .tmp_preview.html
 *
 * 说明：这是一个轻量近似渲染器（WXML → HTML 的子集转换），
 * 目的是在真机/开发者工具之外快速发现排版问题，不是完整 WXML 引擎。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'miniapp');
// 报告样本：优先用外部 fixture，没有就现场生成一份结构一致的样本，
// 保证这个工具开箱即用、不依赖临时文件。
//
// 支持环境变量指定股票（用于针对具体股票生成结构一致的演示结果）：
//   STOCK_CODE=002636.SZ STOCK_NAME=金安国纪 node tools/render-preview.js
// 上游 Tushare/Railway 不可达时，这样能预览具体股票走完整流程后的最终呈现，
// 页面顶部会清晰标注「演示数据」，避免与真实行情混淆。
const fixturePath = path.join(__dirname, '..', '.tmp_fixture.json');
let report;
if (fs.existsSync(fixturePath) && !process.env.STOCK_CODE) {
  report = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
} else {
  const { buildFixture } = require('./fixture');
  report = buildFixture({
    stock_code: process.env.STOCK_CODE,
    stock_name: process.env.STOCK_NAME,
  });
}
const DEMO_MODE = !!process.env.STOCK_CODE; // 用环境变量生成的样本标记为演示
// 复用页面真正用的预处理逻辑（miniapp/utils/report.js），
// 否则预览里看不到「验证统计量」这类由 JS 生成的内容，
// 会出现「预览好看、真机不对」。
const { enrichReport } = require(path.join(root, 'utils', 'report.js'));
report = enrichReport(report);
const appWxss = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8');
const resultWxss = fs.readFileSync(path.join(root, 'pages', 'result', 'result.wxss'), 'utf8');

// rpx → px（750rpx = 375px，即 1rpx = 0.5px）
const wxssToCss = (css) => css.replace(/([\d.]+)rpx/g, (m, n) => (parseFloat(n) * 0.5).toFixed(2) + 'px');

// 页面样式（result.wxss 目前只有注释）
const pageCss = wxssToCss(appWxss + '\n' + resultWxss);

// ---------- 简化的 WXML 渲染 ----------
// 模板注册表必须在 render 之前声明（const 有 TDZ，声明在使用之后会抛 ReferenceError）
const TEMPLATES = {};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 求值 {{ }} 表达式（只支持本项目用到的语法）
function evalExpr(expr, scope) {
  expr = expr.trim();
  // 兼容直接传入 {{ ... }} 的情况：先剥掉外层大括号
  if (expr.startsWith('{{') && expr.endsWith('}}')) {
    expr = expr.slice(2, -2).trim();
  }
  if (!expr) return '';

  // 剥掉包裹整个表达式的外层平衡括号：
  // 嵌套三元的分支常写成 (a ? b : c)，不带这步的话
  // 分支会被解析成 "(a === 'neg'" 这种带左括号的残片，求值失败
  while (expr.startsWith('(') && expr.endsWith(')')) {
    // 确认这对括号确实包裹整个表达式（在最后字符之前深度不归零）
    let depth = 0;
    let wrapped = true;
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')') {
        depth--;
        if (depth === 0 && i < expr.length - 1) { wrapped = false; break; }
      }
    }
    if (!wrapped || depth !== 0) break;
    expr = expr.slice(1, -1).trim();
  }
  if (!expr) return '';

  // 字面量优先判断：true/false/null/数字/字符串
  // （必须排在属性查找之前，否则 "true" 会被当成 scope 里的属性名而找不到）
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (expr === 'null' || expr === 'undefined') return null;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);
  const strLit = expr.match(/^'([^']*)'$/) || expr.match(/^"([^"]*)"$/);
  if (strLit) return strLit[1];

  // 三元
  const ternary = expr.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
  if (ternary) {
    const cond = evalExpr(ternary[1], scope);
    return cond ? evalExpr(ternary[2], scope) : evalExpr(ternary[3], scope);
  }
  // 逻辑或
  if (expr.includes('||')) {
    const parts = expr.split('||').map((p) => p.trim());
    for (const p of parts) {
      const v = evalExpr(p, scope);
      if (v !== '' && v !== undefined && v !== null && v !== false) return v;
    }
    return evalExpr(parts[parts.length - 1], scope);
  }
  // 逻辑与
  if (expr.includes('&&')) {
    const parts = expr.split('&&').map((p) => p.trim());
    let last = '';
    for (const p of parts) {
      const v = evalExpr(p, scope);
      if (!v) return '';
      last = v;
    }
    return last;
  }
  // 比较
  const cmp = expr.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (cmp) {
    const l = evalExpr(cmp[1], scope);
    const r = evalExpr(cmp[3], scope);
    switch (cmp[2]) {
      case '===': return l === r;
      case '!==': return l !== r;
      case '==': return l == r;
      case '!=': return l != r;
      case '>=': return l >= r;
      case '<=': return l <= r;
      case '>': return l > r;
      case '<': return l < r;
    }
  }
  // 取属性
  const prop = expr.match(/^([\w.]+)$/);
  if (prop) {
    let cur = scope;
    for (const k of prop[1].split('.')) {
      if (cur == null) return '';
      cur = cur[k];
    }
    return cur === undefined || cur === null ? '' : cur;
  }
  // 数字/布尔/字符串字面量已在入口统一处理
  return '';
}

// 解析 WXML → 节点树
function parseWxml(src) {
  src = src.replace(/<!--[\s\S]*?-->/g, '');
  const root = { children: [] };
  const stack = [root];
  // 属性值里可能含有 > （如 {{item.a > 0 ? 'x' : 'y'}}），
  // 所以属性串必须允许引号内的 >；同时属性串不能吞掉结尾的 "/"
  // （自闭合标记要单独捕获，否则自闭合标签会被当成开标签，栈结构错乱）。
  const re = /<(\/)?([a-zA-Z][\w-]*)((?:\s+(?:"[^"]*"|'[^']*'|[^>"'\/])*)?)(\s*\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = src.slice(last, m.index);
    if (text) stack[stack.length - 1].children.push({ type: 'text', text });
    last = m.index + m[0].length;

    const [full, closing, tag, attrsRaw, selfClose] = m;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    // 解析属性
    const attrs = {};
    const aRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = aRe.exec(attrsRaw)) !== null) attrs[a[1]] = a[2];
    const node = { type: 'tag', tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose || selfClose.trim() !== '/') stack.push(node);
  }
  return root;
}

// 渲染节点
function render(node, scope) {
  if (node.type === 'text') {
    // 文本节点里的 {{ }} 也要插值。
    // 只对「插值结果」做 HTML 转义，原文保持原样 ——
    //   - 插值结果可能含 "<"（如 "p<0.001"），不转义会被当成标签开头，
    //     导致后面的文字整段丢失；
    //   - 原文里的小程序实体（如 &gt;）必须原样输出，转义反而会显示成字面量。
    let out = '';
    let lastIdx = 0;
    const re = /\{\{([^}]+)\}\}/g;
    let m;
    while ((m = re.exec(node.text)) !== null) {
      out += node.text.slice(lastIdx, m.index);
      const v = evalExpr(m[1], scope);
      out += esc(v === undefined || v === null ? '' : String(v));
      lastIdx = m.index + m[0].length;
    }
    out += node.text.slice(lastIdx);
    return out;
  }

  const { tag, attrs, children } = node;

  // template 定义：注册
  if (tag === 'template' && attrs.name) {
    TEMPLATES[attrs.name] = { attrs, children };
    return '';
  }
  // template 使用
  if (tag === 'template' && attrs.is) {
    const tpl = TEMPLATES[attrs.is];
    if (!tpl) return '';
    const data = {};
    // 先剥掉外层 {{ }}，再按 key: value 切分
    const raw = (attrs.data || '').replace(/^\s*\{\{/, '').replace(/\}\}\s*$/, '').trim();
    const dRe = /(?:^|,\s*)([\w]+)\s*:\s*([^,]+?)(?=\s*,\s*[\w]+\s*:|$)/g;
    let d;
    while ((d = dRe.exec(raw)) !== null) {
      data[d[1]] = evalExpr(d[2], scope);
    }
    const tscope = Object.assign({}, scope, data);
    return tpl.children.map((c) => render(c, tscope)).join('');
  }

  // wx:for —— 单一渲染路径：先算出列表，再对每一项分别渲染
  let scope2 = scope;
  let list = null;
  if (attrs['wx:for']) {
    list = evalExpr(attrs['wx:for'], scope) || [];
    const itemName = attrs['wx:for-item'] || 'item';
    const idxName = attrs['wx:for-index'] || 'index';
    scope2 = Object.assign({}, scope);
    scope2[itemName] = list[0] || {};
    scope2[idxName] = 0;
  }

  // wx:if / wx:elif
  if (attrs['wx:if'] !== undefined) {
    if (!evalExpr(attrs['wx:if'], scope2)) return '';
  } else if (attrs['wx:elif'] !== undefined) {
    if (!evalExpr(attrs['wx:elif'], scope2)) return '';
  }

  // 渲染函数：给定 scope，产出该节点的 HTML
  const emit = (s) => {
    let cls = attrs.class || '';
    cls = cls.replace(/\{\{([^}]+)\}\}/g, (_, e) => {
      const v = evalExpr(e, s);
      return v === true ? '' : (v === false ? '' : v);
    });
    const st = attrs.style ? ' style="' + esc(attrs.style.replace(/\{\{([^}]+)\}\}/g, (_, e) => evalExpr(e, s))) + '"' : '';
    const openTag = `<${tag}${cls ? ' class="' + esc(cls.trim()) + '"' : ''}${st}>`;
    const inner = children.map((c) => render(c, s)).join('');
    if (['image', 'input', 'icon', 'progress', 'slider', 'switch'].includes(tag)) {
      return openTag;
    }
    return openTag + inner + `</${tag}>`;
  };

  if (list) {
    const itemName = attrs['wx:for-item'] || 'item';
    const idxName = attrs['wx:for-index'] || 'index';
    return list.map((item, i) => {
      const s = Object.assign({}, scope);
      s[itemName] = item;
      s[idxName] = i;
      return emit(s);
    }).join('');
  }

  return emit(scope2);
}

const wxml = fs.readFileSync(path.join(root, 'pages', 'result', 'result.wxml'), 'utf8');
const tree = parseWxml(wxml);
const body = tree.children.map((c) => render(c, { report })).join('');

/**
 * WXML 标签 → HTML 语义映射。
 *
 * 小程序里 <view> 是块级、<text> 是行内、<scroll-view> 可横向滚动，
 * 但浏览器不认识这些标签，会一律按 inline 处理，导致 flex 布局错乱、
 * 块级元素不换行、横向滚动失效。所以这里统一翻译成语义正确的 HTML 标签。
 */
const TAG_MAP = {
  view: 'div',
  text: 'span',
  'scroll-view': 'div',
  block: 'div',
  image: 'img',
  button: 'button',
  navigator: 'a',
  'cover-view': 'div',
  'cover-image': 'img'
};

function translateTags(html) {
  // 注意：闭合标签必须保留 "/" 前缀，否则会变成开标签把结构彻底破坏
  return html.replace(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g,
    (m, closing, tag, attrs, slash) => {
      const mapped = TAG_MAP[tag];
      if (!mapped) return m;
      if (closing) return `<${closing}${mapped}${attrs}${slash}>`;
      // 小程序专有标签转换成 HTML 后，原标签名选择器（如 scroll-view {}）会失配。
      // 给开标签补一个 wxml-原标签名 的类；若已有 class 属性则合并进去。
      const needMark = tag !== mapped && tag !== 'view' && tag !== 'text' && tag !== 'block';
      if (!needMark) return `<${mapped}${attrs}${slash}>`;
      const mark = `wxml-${tag}`;
      const clsRe = /\sclass=("[^"]*"|'[^']*')/;
      if (clsRe.test(attrs)) {
        const newAttrs = attrs.replace(clsRe, (full, quoted) => {
          const q = quoted[0];
          const inner = quoted.slice(1, -1);
          return ` class=${q}${inner ? inner + ' ' : ''}${mark}${q}`;
        });
        return `<${mapped}${newAttrs}${slash}>`;
      }
      return `<${mapped} class="${mark}"${attrs}${slash}>`;
    });
}

// scroll-view 需要横向滚动能力；同时给 view/text 补上小程序默认样式
const wxmlBaseCss = `
view, .wxml-view { display: block; }
text, .wxml-text { display: inline; }
scroll-view, .wxml-scroll-view {
  display: block;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  /* 让「可横向滑动」这件事在预览里看得见 */
  scrollbar-width: thin;
  scrollbar-color: #4A4A4A #1A1A1A;
}
scroll-view::-webkit-scrollbar { height: 5px; }
scroll-view::-webkit-scrollbar-thumb { background: #4A4A4A; border-radius: 3px; }
scroll-view::-webkit-scrollbar-track { background: #232323; border-radius: 3px; }
.wxml-block { display: contents; }
img { display: inline-block; }
button { font-family: inherit; box-sizing: border-box; text-align: center; }
`;

const translatedBody = translateTags(body);

// 在第一个统计表上方注入「可横向滑动」提示，其余表格不加（避免重复噪音）
const TIP = '<div class="scroll-tip"><span class="arrow">← →</span><span>表格可左右滑动查看完整 8 列</span></div>';
// 注意：翻译后 scroll-view 的 class 会变成 "table-scroll wxml-scroll-view"，
// 必须用正则匹配而不是精确字符串
const bodyWithTip = translatedBody.replace(
  /<div class="table-scroll(?:\s+wxml-scroll-view)?"/,
  TIP + '<div class="table-scroll'
);

// tabBar 模拟：预览里也能看到底部导航的形态
const tabBarHtml = `
  <div class="tab-bar">
    <div class="tab-item active"><img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23D4AF37' stroke-width='2'%3E%3Ccircle cx='10' cy='10' r='7'/%3E%3Cpath d='M15.5 15.5 L21 21'/%3E%3C/svg%3E" alt=""><span>查个股</span></div>
    <div class="tab-item"><img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%238C8C8C' stroke-width='2'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 6.5 V12 L16 14'/%3E%3C/svg%3E" alt=""><span>历史记录</span></div>
  </div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>稻谷查查 - 结果页预览</title>
<style>
${wxmlBaseCss}
${pageCss}
html, body { margin: 0; padding: 0; background: #0E0E0E; }
body { display: flex; justify-content: center; }
/* 手机外框，模拟真机视口 */
.phone {
  width: 375px;
  min-height: 100vh;
  background: #1A1A1A;
  box-sizing: border-box;
  box-shadow: 0 0 40px rgba(0,0,0,0.6);
}
/* 状态栏，提示这是小程序顶部 */
.status-bar {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  font-size: 12px;
  color: #B0B0B0;
  background: #1A3A1A;
}
.status-bar .time { font-weight: 600; color: #E0E0E0; }
.nav-bar {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  color: #FFFFFF;
  background: #1A3A1A;
}
/* 提示条：说明表格可横向滑动 */
.scroll-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #8C8C8C;
  padding: 6px 2px 0;
}
.scroll-tip .arrow { color: #D4AF37; }
/* tabBar 模拟 */
.tab-bar {
  position: sticky;
  bottom: 0;
  height: 50px;
  display: flex;
  background: #1A1A1A;
  border-top: 1px solid #2A2A2A;
}
.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 10px;
  color: #8C8C8C;
}
.tab-item.active { color: #D4AF37; }
.tab-item img { width: 20px; height: 20px; }
${DEMO_MODE ? `
.demo-banner {
  background: #6B4E00;
  color: #FFD700;
  font-size: 12px;
  padding: 8px 14px;
  text-align: center;
  line-height: 1.5;
  border-bottom: 1px solid #4A3500;
}
.demo-banner b { color: #FF7A8F; }` : ''}
</style>
</head>
<body>
<div class="phone">
  <div class="status-bar"><span class="time">9:41</span><span>稻谷查查</span><span>●●● ▲ ▮</span></div>
  <div class="nav-bar">稻谷查查</div>
${DEMO_MODE ? `<div class="demo-banner">⚠ <b>演示数据</b> · 后端 Railway 服务已下线、Tushare 上游不可达，本页用与生产同结构的样例数据呈现「${report.stock_name}」走完整流程后的最终排版。等后端恢复后查询 <b>${report.stock_code}</b> 即可获得真实行情分析。</div>` : ''}
${bodyWithTip}
${tabBarHtml}
</div>
</body>
</html>`;

process.stdout.write(html);
