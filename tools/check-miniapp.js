/**
 * 小程序静态检查：WXML 标签闭合、事件绑定与 JS 方法对应、模板引用完整性。
 * 用法：node tools/check-miniapp.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'miniapp');
let errors = 0;
let warnings = 0;

function err(file, msg) {
  errors++;
  console.log(`  [错误] ${file}: ${msg}`);
}
function warn(file, msg) {
  warnings++;
  console.log(`  [警告] ${file}: ${msg}`);
}

// ---------- 1. WXML 标签闭合检查 ----------
const VOID_TAGS = ['image', 'input', 'icon', 'progress', 'slider', 'switch', 'textarea', 'camera', 'live-player', 'live-pusher', 'open-data', 'web-view', 'ad', 'match-media', 'page-meta', 'navigation-bar', 'root-portal'];

function checkWxml(file) {
  const src = fs.readFileSync(file, 'utf8');
  // 去掉注释
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const [full, tag, attrs, selfClose] = m;
    const line = clean.slice(0, m.index).split('\n').length;
    if (full.startsWith('</')) {
      if (stack.length === 0) {
        err(file, `第 ${line} 行出现孤立闭合标签 </${tag}>`);
      } else {
        const top = stack.pop();
        if (top.tag !== tag) {
          err(file, `第 ${line} 行标签不匹配：期望 </${top.tag}>（开于第 ${top.line} 行），实际 </${tag}>`);
        }
      }
    } else {
      if (selfClose === '/' || VOID_TAGS.includes(tag.toLowerCase())) continue;
      stack.push({ tag, line });
    }
  }
  stack.forEach((t) => err(file, `标签 <${t.tag}>（第 ${t.line} 行）未闭合`));
}

// ---------- 2. WXML 中不应出现 HTML 标签 ----------
function checkNoHtmlTags(file) {
  const src = fs.readFileSync(file, 'utf8');
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');
  const htmlTags = ['b', 'i', 'u', 'strong', 'em', 'br', 'p', 'span', 'div', 'font'];
  const re = new RegExp(`</?(${htmlTags.join('|')})[\\s>]`, 'gi');
  let m;
  while ((m = re.exec(clean)) !== null) {
    const line = clean.slice(0, m.index).split('\n').length;
    err(file, `第 ${line} 行使用了 WXML 不支持的 HTML 标签 <${m[1]}>，请改用 <text class="...">`);
  }
}

// ---------- 3. 事件绑定的方法必须在 JS 中存在 ----------
function checkEventHandlers(file, jsFile) {
  const wxml = fs.readFileSync(file, 'utf8');
  const js = fs.readFileSync(jsFile, 'utf8');
  const handlers = new Set();
  const re = /\b(?:bind|catch)(?::)?[a-zA-Z-]+\s*=\s*"([^"{}]+)"/g;
  let m;
  while ((m = re.exec(wxml)) !== null) {
    m[1].split(/\s+/).filter(Boolean).forEach((h) => handlers.add(h));
  }
  handlers.forEach((h) => {
    // 模板 is= 中可能出现的方法名也要查
    const pattern = new RegExp(`(^|[\\s,{])${h}\\s*(\\(|:|\\s*=)`, 'm');
    if (!pattern.test(js)) {
      err(file, `绑定的事件处理函数 "${h}" 在 ${path.basename(jsFile)} 中未找到`);
    }
  });
}

// ---------- 4. template 使用与定义匹配 ----------
function checkTemplates(file) {
  const src = fs.readFileSync(file, 'utf8');
  const defined = new Set();
  const defRe = /<template\s+name\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = defRe.exec(src)) !== null) defined.add(m[1]);
  const useRe = /<template\s+is\s*=\s*"([^"]+)"/g;
  while ((m = useRe.exec(src)) !== null) {
    if (!defined.has(m[1])) {
      err(file, `使用了未定义的模板 "${m[1]}"`);
    }
  }
  return defined;
}

// ---------- 5. app.json 引用的页面文件必须存在 ----------
function checkPages() {
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  appJson.pages.forEach((p) => {
    ['js', 'wxml', 'json', 'wxss'].forEach((ext) => {
      const f = path.join(root, p + '.' + ext);
      if (!fs.existsSync(f)) {
        // 页面级 json 可选
        if (ext === 'json') return;
        err('app.json', `页面 ${p} 缺少 ${p}.${ext}`);
      }
    });
  });
  // tabBar 图标必须存在
  if (appJson.tabBar) {
    appJson.tabBar.list.forEach((item) => {
      ['iconPath', 'selectedIconPath'].forEach((k) => {
        if (item[k] && !fs.existsSync(path.join(root, item[k]))) {
          err('app.json', `tabBar 图标不存在: ${item[k]}`);
        }
      });
    });
  }
}

// ---------- 6. 页面里引用的图片必须存在 ----------
function checkImages(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /src\s*=\s*"\/([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!fs.existsSync(path.join(root, m[1]))) {
      err(file, `引用的图片不存在: /${m[1]}`);
    }
  }
}

// ---------- 7. setData 的字段应在 data 中声明（粗查） ----------
function checkSetData(jsFile) {
  const src = fs.readFileSync(jsFile, 'utf8');
  const dataMatch = src.match(/data\s*:\s*{([\s\S]*?)\n\s{2}\}/);
  if (!dataMatch) return;
  const declared = new Set();
  const dRe = /^\s*([a-zA-Z_$][\w$]*)\s*:/gm;
  let m;
  while ((m = dRe.exec(dataMatch[1])) !== null) declared.add(m[1]);
  // find all setData({...}) calls
  const sRe = /setData\(\s*{([\s\S]*?)}\s*\)/g;
  while ((m = sRe.exec(src)) !== null) {
    const kRe = /([a-zA-Z_$][\w$]*)\s*:/g;
    let k;
    while ((k = kRe.exec(m[1])) !== null) {
      if (!declared.has(k[1])) {
        warn(jsFile, `setData 设置了未在 data 中声明的字段 "${k[1]}"`);
      }
    }
  }
}

// ---------- 执行 ----------
console.log('=== WXML 标签闭合检查 ===');
const wxmlFiles = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.wxml')) wxmlFiles.push(p);
  });
})(root);

wxmlFiles.forEach((f) => {
  const before = errors;
  checkWxml(f);
  if (errors === before) console.log(`  OK: ${path.relative(root, f)}`);
});

console.log('\n=== WXML HTML 标签检查 ===');
wxmlFiles.forEach((f) => checkNoHtmlTags(f));
console.log('  (无输出即通过)');

console.log('\n=== 事件处理函数检查 ===');
wxmlFiles.forEach((f) => {
  const jsFile = f.replace(/\.wxml$/, '.js');
  if (fs.existsSync(jsFile)) checkEventHandlers(f, jsFile);
});
console.log('  (无输出即通过)');

console.log('\n=== template 定义/使用检查 ===');
wxmlFiles.forEach((f) => checkTemplates(f));
console.log('  (无输出即通过)');

console.log('\n=== 图片资源检查 ===');
wxmlFiles.forEach((f) => checkImages(f));
console.log('  (无输出即通过)');

console.log('\n=== app.json 页面与 tabBar 图标检查 ===');
checkPages();
console.log('  (无输出即通过)');

console.log('\n=== setData 字段声明检查 ===');
['app.js', 'pages/index/index.js', 'pages/result/result.js', 'pages/history/history.js'].forEach((f) => {
  const p = path.join(root, f);
  if (fs.existsSync(p)) checkSetData(p);
});
console.log('  (无输出即通过)');

console.log(`\n========== 错误 ${errors} 个，警告 ${warnings} 个 ==========`);
process.exit(errors > 0 ? 1 : 0);
