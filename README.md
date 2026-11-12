# 续记 Renewly

一个支持多用户的订阅管理网站。首期管理云服务器，集中记录商家、价格、续费日期、地区、型号、带宽和套餐流量总额度，按参考汇率查看年度预算与剩余使用价值。

界面支持浅色、深色和跟随系统，采用实色面板、柔和背景与渐变强调文字。外观选择在当前浏览器中保存，标签页使用适配深浅背景的通用订阅卡片图标。前台只展示自己的数据，管理页负责编辑；未启用的订阅类别不会出现在界面中。

## 功能

- 邮箱密码注册与登录，服务端会话、用户数据隔离和管理员权限。
- 云服务器新增、编辑、归档和续费登记；默认只填写本期费用，续费价格不同时展开额外输入，编辑时保留历史首购价格。
- 人民币、美元、欧元、英镑，Frankfurter 参考汇率缓存与失败回退提示。
- 年化续费预算、未来 30 天待续费、已付账期剩余使用价值，以及紧凑清单中的账期剩余进度。
- 单台服务器带宽：Mbps / Gbps，不显示带宽合计。
- 套餐流量总额度：GB / TB、不限流量、未填写。
- 商家自动续费标记：仍按原提醒设置发送到期邮件，确认商家扣款后再登记续费。
- 管理员用户管理：搜索用户、修改姓名和角色、启停账号；停用后已有会话失效，各用户的订阅数据仍独立。
- 用户只填写收件邮箱与提醒偏好；管理员统一维护 SMTP 或 Resend 发信服务。
- 服务端到期提醒、邮箱验证、投递日志和重复发送去重。
- 账期开始和续费时间支持小时、分钟，默认 `00:00`；按账户时区计算倒计时、进度和剩余价值。提前提醒在对应日期的同一时分触发，邮件注明时区，服务端默认每分钟检查一次。
- 通用订阅核心与类型详情分离，便于以后增加其他类别。

## 技术栈

React、TypeScript、Vite、Hono、Node.js、SQLite、Docker Compose。GitHub Actions 在线检查与构建，通过 GHCR 分发 Linux amd64 / arm64 镜像。

## 本地运行

需要 Node.js 24 或更高版本，以及 npm。

```bash
git clone https://github.com/ZikQ-Shmily/renewly.git
cd renewly
npm ci
cp .env.example .env
```

编辑 `.env`，本地预览至少设置：

```dotenv
NODE_ENV=development
APP_URL=http://localhost:3000
COOKIE_SECURE=false
APP_SECRET=请替换为随机生成的应用密钥
BOOTSTRAP_ADMIN_EMAIL=你的管理员邮箱
BOOTSTRAP_ADMIN_PASSWORD=你的强密码
DATA_DIR=./data
```

生成应用密钥：

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64') + '\n')"
```

```bash
npm run build
npm start
```

打开 [http://localhost:3000](http://localhost:3000)，使用初始化的管理员账号登录。管理员引导只在首次创建账户时生效，后续启动不会重置已有密码。生产环境使用 HTTPS，并保留 `COOKIE_SECURE=true`。

验证代码：

```bash
npm run typecheck
npm test
npm run build
```

## 云服务器部署

1. 在仓库的 **Actions → CI & Container** 确认默认分支构建成功，使用 `ghcr.io/zikq-shmily/renewly:latest`。
2. 在装有 Docker Engine 和 Compose v2 的云服务器上，准备 `compose.yaml`、`.env` 与 `deploy/`。
3. 配置真实的 `APP_URL`、应用密钥、管理员账号和 `RENEWLY_IMAGE`，运行 `docker compose up -d --wait`。
4. 配置 HTTPS 反向代理，再由管理员登录配置邮件服务。

SQLite 位于持久化数据卷 `renewly-data`。更新容器时复用该数据卷；应用镜像、GitHub 仓库和构建产物不包含运行中的用户数据库。

v3 数据库结构会在应用启动时自动增量迁移，保留已有用户、订阅和提醒记录；旧日期自动补为 `00:00`。部署更新前应备份数据库；`deploy/update.sh` 已包含更新前备份。

完整的首次安装、私有镜像认证、备份、更新、回滚及可选 SSH 发布说明见 [部署文档](docs/DEPLOYMENT.md)。

## 在线构建

推送到 `main`、推送 `v*` 标签或手动运行工作流，将执行类型检查、测试与构建。全部通过后，GitHub Actions 构建并推送 GHCR 镜像。Pull request 只运行检查，不发布镜像。

默认分支构建成功后会更新 `latest` 标签。服务器可通过 `bash deploy/update.sh ghcr.io/zikq-shmily/renewly:latest` 拉取并切换到最新镜像，也支持使用摘要 `@sha256:…` 或完整提交标签 `:sha-<40 位提交号>` 指定版本。另有手动 **Deploy server (manual)** 工作流，需先配置 `production` 环境、部署 Secrets 和服务器文件。

## 数据与邮件

- 数据库按 `user_id` 校验归属；普通用户不能读取其他人的订阅或管理员邮件设置。
- `APP_SECRET` 用于保护服务端敏感配置，应长期保存，并与数据库备份一同妥善保管。
- 发信凭据保存在服务端，接口仅返回是否已配置；日志不包含 API Key 或 SMTP 密码。
- 采用 SQLite 在线备份生成一致性副本，并将副本复制到独立位置保存。更新前也会备份数据库。
- 汇率是参考汇率，年度预算为估算；剩余使用价值不是商家可退余额。

本仓库包含应用与部署配置，实际访问域名和服务器部署状态取决于使用者的环境配置。
