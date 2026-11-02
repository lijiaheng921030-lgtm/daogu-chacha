/**
 * 把新的后端地址写入小程序端的 API_BASES 首位，并跑验证。
 *
 * 用法：
 *   node tools/set-api-base.js https://daogu-chacha.onrender.com
 *   node tools/set-api-base.js https://xxx.onrender.com --no-verify   # 只改不验证
 *
 * 做的事：
 *   1. 改写 miniapp/utils/api.js 的 API_BASES 数组，把新地址放到第一位
 *   2. 保留原有地址作为兜底（除非新地址和已有的重复）
 *   3. 调用后端验证接口真的能用
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API_JS = path.join(__dirname, '..', 'miniapp', 'utils', 'api.js');

const args = process.argv.slice(2);
const newBase = (args.find((a) => !a.startsWith('--')) || '').trim().replace(/\/+$/, '');
const skipVerify = args.includes('--no-verify');

if (!newBase) {
  console.error('用法: node tools/set-api-base.js https://你的域名.onrender.com [--no-verify]');
  process.exit(1);
}

if (!/^https?:\/\/[^\s]+$/.test(newBase)) {
  console.error('✗ 地址格式不对，需要以 http:// 或 https:// 开头：' + newBase);
  process.exit(1);
}

// ---- 读取现有 API_BASES ----
const src = fs.readFileSync(API_JS, 'utf8');
const blockMatch = src.match(/const API_BASES = \[([\s\S]*?)\];/);
if (!blockMatch) {
  console.error('✗ 在 api.js 里找不到 API_BASES 数组');
  process.exit(1);
}

const existing = [];
const entryRe = /'([^']+)'/g;
let m;
while ((m = entryRe.exec(blockMatch[1])) !== null) existing.push(m[1]);

// ---- 重新组装：新地址第一，其余保留（去掉重复）----
const merged = [newBase, ...existing.filter((u) => u !== newBase)];

// 保留原有注释（关于多个后端回退的那段说明），只替换数组内容
const newBlock = 'const API_BASES = [\n' +
  merged.map((u, i) => {
    const isNew = i === 0 && u === newBase && !existing.includes(newBase);
    const comment = isNew ? '    // 新部署的后端，放最前优先尝试' : '';
    return comment + "  '" + u + "'" + (i < merged.length - 1 ? ',' : '');
  }).join('\n') +
  '\n];';

const newSrc = src.replace(/const API_BASES = \[[\s\S]*?\];/, newBlock);
if (newSrc === src && merged.join() !== existing.join()) {
  console.error('✗ 替换失败，文件未改动');
  process.exit(1);
}

fs.writeFileSync(API_JS, newSrc);
console.log('✓ 已更新 ' + path.relative(path.join(__dirname, '..'), API_JS));
console.log('');
console.log('API_BASES 现在的顺序：');
merged.forEach((u, i) => console.log('  ' + (i + 1) + '. ' + u + (i === 0 ? '   ← 优先' : '   （兜底）')));
console.log('');

if (skipVerify) {
  console.log('已跳过验证（--no-verify）');
  process.exit(0);
}

// ---- 验证 ----
console.log('=== 验证新后端 ===');
try {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, 'verify-deploy.js'), newBase],
    { encoding: 'utf8', timeout: 180000 }
  );
  console.log(out);
} catch (e) {
  // verify-deploy 用退出码表示结果，失败时 stdout 也有内容
  if (e.stdout) console.log(e.stdout);
  console.log('✗ 验证未通过 —— 代码已改好，但后端还需要检查');
  console.log('  常见原因：Render 还在构建（等 Deploys 变 Live 再试）');
  process.exit(1);
}
