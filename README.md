# 稻谷查查 - 个股次日红绿盘统计分析小程序

微信小程序 → Node.js 后端（Railway / Render）→ Tushare + BaoStock

基于「某只股票自己的历史」统计出「什么样的盘面形态，次日更容易收红」，
所有维度都经过跨股票检验（10 只股票、3335 个样本），未通过检验的维度不充数。

---

## 架构

```
微信小程序 (miniapp/)
      │  POST /api/statAnalyze
      ▼
Node.js + Express (server/)
      ├── Tushare Pro   日线K线
      ├── BaoStock      5分钟线（分时形态）
      └── validated.js  跨股票检验结果（预计算）
      ▼
Railway (Docker)  /  Render
```

### 后端接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查（Railway/Render 探活） |
| POST | `/api/statAnalyze` | 统计分析主接口，入参 `{stock_code, days}` |
| POST | `/api/analyze` | 旧版综合分析接口（保留兼容，statAnalyze 不使用） |

`/api/statAnalyze` 错误码约定：

| code | 含义 | 小程序端处理 |
|------|------|------|
| 0 | 成功 | 正常渲染 |
| 400 | 缺少参数 | 提示重新输入 |
| 404 | 代码无法识别 / 数据不足（次新股） | 提示检查代码 |
| 500 | 服务器内部错误 | 提示稍后重试 |
| 502 | 上游数据源不可用（Token 失效、接口未开通） | 提示数据源问题 |

---

## 目录结构

```
daogu_chacha/
├── miniapp/                    微信小程序前端
│   ├── app.js                  全局配置
│   ├── app.json                页面/tabBar/窗口配置
│   ├── app.wxss                全局样式
│   ├── utils/
│   │   ├── api.js               请求层（多后端回退 + 冷启动预热 + 错误分级）
│   │   ├── report.js            报告预处理（验证统计量文案）
│   │   ├── verdict.js           A/B/C 裁决推导（从真实分层数据算，不硬编码）
│   │   └── history.js           历史记录 + 报告缓存管理
│   ├── images/                 图标资源
│   └── pages/
│       ├── index/              首页（搜索、样本区间、快捷股）
│       ├── result/             结果页（11 维度统计表 + 验证明细 + Top10）
│       └── history/            历史记录页
├── server/                     Node.js 后端
│   ├── index.js                Express 服务 + /api/statAnalyze
│   ├── tushare.js              Tushare 数据封装
│   ├── baostock.js             BaoStock 5 分钟线封装
│   ├── fenshi.js               日内形态分类规则
│   ├── validated.js            跨股票检验结果（预计算）
│   └── backtest.js             旧版 analyze 接口
├── worker/                     Cloudflare Worker（旧方案，当前未使用）
├── tools/
│   ├── gen-tab-icons.js        生成 tabBar 图标 PNG
│   ├── check-miniapp.js        小程序静态检查
│   ├── test-logic.js           业务逻辑单元测试
│   ├── fixture.js              离线报告样本（与生产同结构）
│   └── render-preview.js       WXML → HTML 离线预览渲染器
├── Dockerfile / railway.json   Railway 部署
├── render.yaml                 Render 部署
└── .github/workflows/deploy.yml  Cloudflare Worker 部署（当前未使用）
```

---

## 部署

### 一、后端（Render，当前生产环境）

> **为什么从 Railway 迁走**：Railway 试用计划已于 2026-11 到期，
> `railway up` 直接被拒（`Your trial has expired`），服务状态变成 Failed。
> 代码本身没问题 —— 本地 `node server/index.js` 跑通，Railway 日志里
> 也显示容器确实启动过（`稻谷查查1.0 运行在 http://localhost:3002`）。

1. 推送到 GitHub 仓库（`render.yaml` 已在仓库根目录）。
2. Render → **New** → **Blueprint** → 选 `lijiaheng921030-lgtm/daogu-chacha` 仓库
   → Render 会自动读取 `render.yaml` → 点 **Apply**。
3. Render 会创建两个资源：
   - **web service `daogu-chacha`**：`rootDir: server`，构建 `npm install`，
     启动 `node index.js`，健康检查 `/api/health`，free plan
   - **cron job `keep-alive`**：每 10 分钟 ping 一次 `/api/health`
     （free plan 15 分钟无请求会休眠，唤醒要 ~30 秒，
     而一次统计查询本身要 40~50 秒，两者叠加会超小程序 60 秒上限，
     所以必须靠这个 cron 保持常驻）
4. 部署完成后拿到域名，形如 `https://daogu-chacha.onrender.com`。
5. 把新域名填进 `miniapp/utils/api.js` 的 `API_BASES` **第一位**：

```javascript
const API_BASES = [
  'https://daogu-chacha.onrender.com',   // 新后端放最前
  'https://daogu-server-production.up.railway.app',  // 旧的留作兜底
];
```

> **关于 Tushare Token**：`render.yaml` 里写了默认值，部署后即可直接用。
> 代码里是 `process.env.TUSHARE_TOKEN || '<默认值>'` 的双重保险 ——
> 环境变量优先，缺失时回落到默认值，保证部署后不会因为漏配变量而起不来。
> 如果要更高安全性：在 Render 控制台把 `TUSHARE_TOKEN` 改成 **Secret**，
> 或直接轮换代理 token（只有这一个调用点会用到）。

### 二、后端（Railway，已停用）

配置仍在 `railway.json` / `Dockerfile`，随时可以恢复：
Railway → 升级到 Hobby 计划（$5/月）→ `railway up`。
不升级的话 Railway 会一直拒绝部署。

### 三、小程序

1. 微信开发者工具 → 导入项目 → 目录选 `f:/daogu_chacha/miniapp/`
2. AppID 填 `wx4fae3c135a32c1cc`（测试可用「测试号」）
3. **配置合法域名**（正式版必需）：
   微信公众平台 → 开发管理 → 开发设置 → 服务器域名 →
   request 合法域名填入你的后端域名（Render 域名不需要备案，
   但必须是 HTTPS 且已备案的域名才能加进白名单）。

4. `project.config.json` 里 `urlCheck` 已设为 `true`，
   意味着域名没配好时开发者工具会直接报错，不会静默失败。

#### 请求层说明（`miniapp/utils/api.js`）

小程序端不直接 `wx.request`，统一走这个封装，它负责三件事：

- **多后端回退**：`API_BASES` 逐个尝试，第一个失败自动换下一个。
- **冷启动预热**：每次业务请求前先 `GET /api/health`。
  服务已热时几百毫秒返回；休眠时这个请求会等容器启动完（约 30 秒），
  拆成两次请求后各自都不超 `wx.request` 的 60 秒上限。
- **错误分级**：网络错误 / 超时 / 5xx 视为后端故障（换下一个）；
  业务错误（404 查无此股等）直接交给调用方，换后端没意义。

---

## 本地开发

### 跑后端

```bash
cd server
npm install
TUSHARE_TOKEN=你的token node index.js
# 默认监听 http://localhost:3002
```

本地调试时把 `miniapp/utils/api.js` 的 `API_BASES` 临时改成
`['http://localhost:3002']`（真机调试请用局域网 IP 或内网穿透）。
注意：微信开发者工具默认会校验合法域名，本地调试需要在
「详情 → 本地设置」里勾选「不校验合法域名」。

### 开发者工具静态检查

```bash
node tools/check-miniapp.js
```

检查项：WXML 标签闭合、误用 HTML 标签（如 `<b>`）、事件处理函数是否存在、
template 定义与引用、页面/图标文件是否齐全、setData 字段是否已声明。

### 业务逻辑单元测试

```bash
node tools/test-logic.js
```

覆盖裁决推导（A/B/C 判定、基准计算、边缘信号与噪声过滤）与
历史记录存储（去重、截断、缓存清理、异常降级）。

### 重新生成 tabBar 图标

```bash
node tools/gen-tab-icons.js
```

---

## 数据与方法论说明

- **次日红绿盘**：以上一日收盘为基准，看次日收盘是红是绿。
- **层内红盘率**：该形态样本中次日收红的比例，这是真正的「成功率」；
  而「红占比」只表示这种形态出现得有多频繁，两个口径不要混。
- **基准红盘率**：`total_red / (total_red + total_green)`，
  即这只股票本身平均多少天次日收红。裁决 A/B/C 是相对于这个基准的偏离。
- **跨股票验证**：单个维度只看一只股票，120 个样本很容易把随机波动选成
  「最佳」。所以只有通过 10 只股票、3335 样本检验（p<0.05 且多数股票方向一致）
  的层才会被标为 ✅已验证，验证过的看空层标 ⚠反向，方向一致但没过线的标 ⚠边缘。
- **风险提示**：以上均为历史统计结果，不构成投资建议。

---

## 注意事项

1. **Tushare Token**：Token 失效时后端返回 502，小程序会提示「数据源令牌已失效」。
   需要在 Railway/Render 环境变量里更新。
2. **BaoStock 5 分钟线**：首次拉取较慢（`statAnalyze` 超时设为 60 秒）。
3. **接口耗时**：`days=120` 且需要拉分时数据时，单次请求可能十几秒，
   小程序端已设置 60 秒超时并提供重试按钮。
4. **本地存储**：历史最多保留 10 条，每条报告上限 100KB，
   超限自动降级为只存摘要（可点开看结论，点不开详细表格）。
5. **正式版域名**：不使用 Cloudflare Workers 方案；
   `worker/` 和 `.github/workflows/deploy.yml` 是早期方案，保留但当前未接入。
