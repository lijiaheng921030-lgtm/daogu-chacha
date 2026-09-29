# 稻谷查查1.0 - 部署指南

## 架构

```
微信小程序 → Cloudflare Workers → Tushare API
              (无服务器)
```

## 部署步骤

### 1. 创建 GitHub 仓库

在 GitHub 创建新仓库，将 `daogu_chacha` 文件夹上传：

```bash
cd daogu_chacha
git init
git add .
git commit -m "稻谷查查1.0"
git remote add origin https://github.com/你的用户名/daogu-chacha.git
git push -u origin main
```

### 2. 获取 Cloudflare API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 个人资料 → API Tokens → 创建令牌
3. 使用"编辑 Cloudflare Workers"模板
4. 授予所有账号权限，复制生成的 Token

### 3. 获取 Cloudflare Account ID

在 Cloudflare Dashboard 右侧栏复制 Account ID

### 4. 配置 GitHub Secrets

在 GitHub 仓库 → Settings → Secrets 添加：

| Secret 名称 | 值 |
|------------|-----|
| `CLOUDFLARE_API_TOKEN` | 刚才创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |

### 5. 配置 wrangler.toml

在 `worker/` 目录下创建 `wrangler.toml`：

```toml
name = "daogu-chacha"
main = "index.js"
compatibility_date = "2024-01-01"

[vars]
```

### 6. 自动部署

推送代码到 main 分支，GitHub Actions 会自动部署到 Cloudflare Workers。

或者手动在 GitHub Actions 页面点击 "Run workflow" 立即部署。

### 7. 获取 Worker URL

部署成功后，Worker URL 为：
```
https://daogu-chacha.你的用户名.workers.dev
```

### 8. 更新小程序后端地址

修改 `miniapp/app.js`：
```javascript
apiBase: 'https://daogu-chacha.你的用户名.workers.dev'
```

### 9. 微信开发者工具导入

1. 打开微信开发者工具
2. 项目目录选择 `f:/daogu_chacha/miniapp/`
3. AppID 填 `touristappid`（测试号）
4. 勾选"不校验合法域名"（测试阶段）
5. 导入后测试

---

## 本地开发测试

### 后端模拟
Worker 代码需要部署后才能真机测试，但可以用以下方式本地模拟：

```bash
# 安装 wrangler
npm install -g wrangler

# 本地测试 Worker
cd worker
wrangler dev --port 8787
```

然后在小程序 `app.js` 中临时改为：
```javascript
apiBase: 'http://localhost:8787'
```

---

## 文件说明

```
daogu_chacha/
├── worker/
│   ├── index.js          # Cloudflare Worker（JS版回测+归因）
│   └── wrangler.toml     # Wrangler 配置
├── miniapp/              # 微信小程序前端
│   ├── app.js            # 全局配置（apiBase在这里改）
│   ├── app.json
│   └── pages/
│       ├── index/        # 首页
│       ├── result/       # 结果页
│       └── history/      # 历史记录
├── server/               # Node.js 本地后端（备用）
│   ├── index.js
│   └── backtest.py
└── .github/workflows/
    └── deploy.yml        # 自动部署
```

---

## 注意事项

1. **Tushare Token**：已内置在 worker 代码中，如失效请自行替换
2. **免费额度**：Cloudflare Workers 每日10万请求，够个人使用
3. **HTTPS**：Worker 默认 HTTPS，小程序正式版需要
4. **域名**：微信正式版要求合法域名，可在微信公众平台配置
