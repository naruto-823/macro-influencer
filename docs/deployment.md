# 生产部署

本项目调用 `naruto-823/docker-vps-deploy-template@v1` 发布到单台 VPS。

镜像由 GitHub Actions Buildx 构建并推送到 `ghcr.io/naruto-823/macro-influencer:<commit>`；
VPS 只负责拉取镜像和切换容器，禁止在生产机执行依赖安装或 Docker build。

## GitHub 配置

仓库 Actions Secrets：

- `DEPLOY_HOST`：VPS 公网 IP
- `DEPLOY_USER`：建议为 `deploy`
- `DEPLOY_SSH_KEY`：本项目独立部署私钥
- `DEPLOY_KNOWN_HOSTS`：经人工核对的 SSH host key
- `APP_ENV`：生产环境变量，至少包含 `ANTHROPIC_API_KEY`；使用代理时同时配置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`

仓库 Actions Variable：

- `PRODUCTION_URL`：不带末尾斜杠的公网 HTTPS 地址，例如 `https://influencer.example.com`

`APP_ENV` 示例：

```dotenv
ANTHROPIC_API_KEY=replace-me
ANTHROPIC_BASE_URL=https://your-compatible-gateway.example.com
ANTHROPIC_MODEL=claude-sonnet-4-6
LLM_BACKEND=fox
HOST_PORT=5180
```

## 公网网关

生产 Compose 把应用发布到宿主机 `5180`，供另一个 Docker network 中的共享 Caddy 经 `host.docker.internal` 访问。VPS 防火墙必须只开放 22/80/443，不得向公网放行 5180。共享 Caddy 需要增加一个站点：

```caddyfile
influencer.example.com {
    reverse_proxy host.docker.internal:5180
    encode zstd gzip
}
```

若共享 Caddy 直接运行在宿主机，使用 `reverse_proxy 127.0.0.1:5180`。若 Caddy 在 Docker 中，需确保其能解析 `host.docker.internal`（Linux 下映射到 `host-gateway`）。

部署成功后，`https://influencer.example.com/health` 应返回：

```json
{"status":"ok","service":"macro-influencer"}
```

运行产物与热点缓存分别保存在 Docker named volumes `runs_data`、`cache_data` 中，发布新 commit 不会丢失。
