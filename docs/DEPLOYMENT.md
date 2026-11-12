# 云服务器部署

部署路径为：GitHub 源码 → GitHub Actions 检查与构建 → GHCR 镜像 → 云服务器 Docker Compose。服务器运行已构建的镜像，SQLite、邮件配置及账户数据保存在持久化数据卷。

## 1. 服务器准备

需要 Docker Engine、Docker Compose v2、Bash，以及已经解析到服务器的域名。建议在 `/opt/renewly` 保存部署文件，部署账号需要对此目录和 Docker 有访问权限。

```bash
git clone https://github.com/ZikQ-Shmily/renewly.git /opt/renewly
cd /opt/renewly
cp .env.example .env
chmod 600 .env
```

在仓库 Actions 的 **CI & Container** 中确认默认分支构建成功，在 `.env` 中使用 `latest` 标签：

```dotenv
RENEWLY_IMAGE=ghcr.io/zikq-shmily/renewly:latest
```

默认分支每次构建成功都会更新 `latest`。也可使用工作流摘要中的 `@sha256:…` 或对应提交的完整 `sha-<40位提交号>` 标签指定版本。

## 2. 配置与首次启动

生成随机 `APP_SECRET`：

```bash
docker run --rm node:24-bookworm-slim node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64') + '\n')"
```

编辑 `.env`：

| 配置 | 说明 |
| --- | --- |
| `APP_URL` | 对外完整来源，例如 `https://renewly.example.com`，必须与浏览器访问来源一致 |
| `APP_SECRET` | 随机应用密钥；后续更新继续保留，备份时也要安全保存 |
| `BOOTSTRAP_ADMIN_EMAIL` | 首次初始化管理员邮箱 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 首次初始化管理员强密码 |
| `ALLOW_REGISTRATION` | 是否允许普通用户注册，默认 `true`；注册时必须通过邮箱验证码验证，需先启用管理员发件服务 |
| `COOKIE_SECURE` | 生产 HTTPS 使用 `true` |
| `TRUST_PROXY` | 默认 `false`，在单个可信反向代理入口且应用端口仅限本机访问时设置为 `true` |
| `RENEWLY_IMAGE` | `latest` 标签、完整提交标签或镜像摘要 |
| `RENEWLY_DATA_VOLUME` | 默认 `renewly-data`，更新时保持相同名称 |

Compose 默认只将应用端口绑定至 `127.0.0.1:3000`，适合本机 Nginx 或其他反向代理。数据库目录在容器内为 `/app/data`，由命名数据卷持久化。应用以非 root 用户运行；数据库与备份目录均位于可写数据卷，容器其他文件系统为只读。

若 GHCR 包为私有，服务器需要提前登录：

```bash
docker login ghcr.io -u 你的GitHub用户名
```

密码提示中使用有该包读取权限、scope 为 `read:packages` 的凭据。公开仓库不会自动让已有 GHCR 包公开；可在 GitHub 包设置中选择包的可见性，或保留私有并为服务器配置只读认证。工作流的临时 `GITHUB_TOKEN` 只供 Actions 发布使用。

```bash
docker compose pull app
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:3000/api/health
```

应用启动时会执行数据库迁移并初始化首次管理员。已有管理员时不会因环境变量而重置其密码。

## 3. 域名与 HTTPS

参考 [Nginx 示例](../deploy/nginx.example.conf)，替换域名和证书路径，将 HTTPS 请求代理到 `http://127.0.0.1:3000`。使用已有反向代理管理面板也可以，需转发正确的 Host 与协议头。

`TRUST_PROXY=true` 使用单个可信代理入口模型。该入口须将 `X-Forwarded-For` 覆盖为实际连接来源，示例使用 `proxy_set_header X-Forwarded-For $remote_addr`。代理端口面向用户，应用端口保持本机绑定。多层 CDN 或代理须先正确配置入口的真实来源解析，再覆盖该头，避免客户端自带的转发头影响限流。

首次使用浏览器登录前，先确保 `APP_URL`、HTTPS 和 `COOKIE_SECURE` 一致。若只在本机临时通过 HTTP 调试，使用相应的 HTTP `APP_URL` 与 `COOKIE_SECURE=false`。

登录管理员后，在系统邮件页配置发件身份与 SMTP / Resend 服务，测试成功后再启用。普通用户不需要配置发件凭据。定时提醒由应用单实例后台执行，保持一个 `app` 实例。

开放注册后，新用户在注册页填写邮箱并发送 6 位验证码，验证后才能创建账户；验证码 10 分钟有效，60 秒后可重新发送，最多尝试 5 次，重新发送会使旧码失效。注册使用上述发件服务，未启用或邮件发送失败时不允许跳过验证。已有账户的登录和管理员创建账户流程不受影响。

注册成功的邮箱会作为已验证的默认提醒收件地址；用户以后更换收件地址仍须验证新地址。应用会将验证码摘要、有效期、失败次数和发送限流记录保存在 SQLite 中，重启后继续生效，并按邮箱、来源和全站限制发送频率。应保留原 `APP_SECRET`，也应按前述说明正确配置可信代理来源。

## 4. 更新应用

先将服务器上的部署文件更新至目标代码版本，保留自己的 `.env` 与数据卷。默认分支的新镜像构建成功后执行：

```bash
cd /opt/renewly
bash deploy/update.sh ghcr.io/zikq-shmily/renewly:latest
```

更新脚本会：

1. 保存当前容器的实际镜像 ID，拉取指定镜像，并检查持久化数据库是否存在。
2. 若已有数据库，通过 CLI 生成在线备份。
3. 停止旧应用，执行新版本数据库迁移。
4. 启动新应用并等待健康检查。
5. 成功后保存当前镜像引用；健康检查失败时使用更新前保存的镜像 ID 启动上一应用镜像。

脚本不会自动还原数据库。迁移失败时会停止部署并保留备份；涉及不兼容表结构的版本，应按该版本迁移说明选择恢复方式。镜像回退不能替代数据库恢复。

`.deploy-state/previous-image` 记录上一次容器的本机镜像 ID，便于在 `latest` 标签更新后定位原版本。若发现 `.deploy-lock`，先确认没有更新任务运行；确定为中断残留后再清理该空目录。

## 5. 数据库备份与恢复

生成一致性备份：

```bash
docker compose exec -T app node dist/server/cli.js backup /app/data/backups/manual.sqlite
mkdir -p backups
docker compose cp app:/app/data/backups/manual.sqlite ./backups/manual.sqlite
```

然后将导出的备份与安全保存的 `.env` 配置，复制到独立于本机磁盘的位置。命令中的备份文件是在线备份工具生成的一致性副本，可以复制；运行中的 `renewly.sqlite` 主文件不能单独作为可靠备份，因为已提交内容可能仍在 WAL 文件中。

恢复应在停止应用后进行，先保留当前数据卷副本，再以经过验证的备份恢复到数据库路径。需要同时保存匹配的 `APP_SECRET`，否则先前加密的邮件凭据可能无法解密。恢复后检查登录、订阅、账期与提醒记录，再恢复服务。

## 6. 可选 GitHub 手动发布

仓库的 **Deploy server (manual)** 只在手动触发时执行。先在 GitHub 创建 `production` Environment，并配置需要的审核者。GitHub 的 Environment 审核规则由仓库设置控制，工作流文件中的环境名称不会自行创建审核规则。

在该环境中配置 Secrets：

| Secret | 用途 |
| --- | --- |
| `DEPLOY_HOST` | 服务器域名或 IP |
| `DEPLOY_USER` | 专用部署账号 |
| `DEPLOY_PORT` | SSH 端口，可留空使用 22 |
| `DEPLOY_SSH_KEY` | 部署账号专用私钥 |
| `DEPLOY_KNOWN_HOSTS` | 经管理员核验的服务器 SSH 主机密钥记录 |

可选 Environment variable：`DEPLOY_PATH`，默认 `/opt/renewly`。目录仅允许字母、数字、下划线、点、短横线与斜线。服务器应已准备 `.env`、Compose、更新脚本和镜像读取权限。

填写 `ghcr.io/zikq-shmily/renewly:latest`、成功构建的镜像摘要或完整提交标签，手动运行工作流并按环境规则审批。工作流使用严格主机密钥检查连接该服务器。

## 官方参考

- [GitHub Actions 构建并发布容器](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GHCR 认证与读取权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker Compose 生产部署](https://docs.docker.com/compose/how-tos/production/)
- [Docker 数据卷](https://docs.docker.com/engine/storage/volumes/)
- [SQLite 在线备份](https://sqlite.org/backup.html)
