# 麒麟 V10 Docker 部署说明

适用目标：Kylin Linux Advanced Server V10 (Halberd)。容器使用 Node.js 24.21.0 和 Debian Bookworm 用户空间，宿主机无需安装 Node.js、npm 或 SQLite。前端不需要构建。运行单个应用容器，账号、会话和日志保存在 Docker 数据卷中，共享文件从宿主机可写挂载，以支持管理员删除。

已确认目标服务器：aarch64、内核 4.19.90-89.26.v2401.ky10.aarch64、Docker Engine 20.10.24（linux/arm64）。镜像使用 linux/arm64；内核满足 Node.js 24 官方基线。尚未在目标麒麟服务器实际运行验证。未确认安装 Compose 时，可直接使用第 4 节的 docker run。

## 使用交付的离线包

上传 `wangpan-1.0.0-kylin-arm64.tar.gz` 后执行：

```sh
tar -xzf wangpan-1.0.0-kylin-arm64.tar.gz
cd kylin-arm64
docker load -i wangpan-1.0.0-arm64.tar
```

接着按第 2 节准备目录和 `.env.docker`，再执行第 4 节的 `docker volume create` 和 `docker run`，跳过 `docker build`。该交付包包含成品镜像、配置模板和文档，不包含构建用源码。启动后访问 `http://服务器IP:3000`。

## 1. 确认服务器环境

```sh
uname -m
uname -r
docker version
docker compose version
```

| uname -m | 构建平台 |
| --- | --- |
| x86_64 | linux/amd64 |
| aarch64 | linux/arm64 |

其他架构需另行确认 Node.js 镜像和原生依赖支持，不能直接套用上表。Node.js 24 官方 Linux x64/arm64 支持基线为内核 4.18；镜像内的 glibc 由 Debian 提供，不取决于麒麟宿主机 glibc。参见 [Node.js 24 平台要求](https://github.com/nodejs/node/blob/v24.x/BUILDING.md) 和 [Node 官方镜像](https://hub.docker.com/_/node)。

下文命令在项目目录执行，并使用具有 Docker 操作权限的账号。使用 Compose v2 或更新版本；没有 Compose 时使用第 4 节的 docker run。

## 2. 准备配置和共享目录

```sh
sudo mkdir -p /srv/wangpan/files
sudo chmod 0755 /srv/wangpan/files
cp deploy/docker.env.example .env.docker
chmod 0600 .env.docker
openssl rand -hex 48
```

仅首次部署执行配置复制。把生成的随机值填入 `.env.docker` 的 `SESSION_SECRET`，保留该值用于后续重建和更新。配置文件不会进入镜像。

把待下载文件放入 `/srv/wangpan/files`。容器以 UID/GID 1000 运行，需要对共享文件有读权限、对各层目录有遍历权限；新增文件也应满足此要求。SQLite 使用 `wangpan-data` 命名卷，首次由镜像中的目录权限初始化，无需在宿主机安装数据库。

默认通过 HTTP 直连，配置为 `COOKIE_SECURE=false`、`TRUST_PROXY=false`，端口为 3000。需要 HTTPS 时接入反向代理，设置 `COOKIE_SECURE=true`，并按容器实际看到的代理来源地址设置 `TRUST_PROXY`；宿主机 Nginx 经过 Docker 网桥进入容器时，来源通常不是 loopback，不能直接照搬宿主机部署的代理配置。

## 3. 联网构建和 Compose 启动

把项目源码和部署文件复制到服务器，在项目目录执行：

```sh
docker compose build
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 wangpan
```

构建在目标平台安装锁定依赖，并打开内存 SQLite 检查 `better-sqlite3` 是否可加载。不会复制 Mac 的 `node_modules`、本地 `.env` 或数据库。

当前锁定的 `better-sqlite3` 13.0.3 包含 Linux ARM64 原生文件，Dockerfile 使用 `npm ci --omit=dev --ignore-scripts` 跳过 npm 隐式触发的 node-gyp。构建中的 SQLite 实际查询负责验证原生文件可用；升级依赖时应重新确认是否需要安装脚本。

访问 `http://服务器IP:3000`。若本机可访问而其他机器无法访问，检查服务器的 3000/TCP 入站规则。首次空数据库账号沿用 [使用说明](使用说明.md)，已有账号不会被覆盖。

修改共享目录时，调整 `compose.yaml` 挂载项左侧的宿主机路径，右侧容器路径保持 `/srv/wangpan/files`。若启用了 SELinux 且出现挂载权限拒绝，核对该专用共享目录的标签；可按现场策略将挂载后缀由 `:rw` 调整为 `:rw,Z`，仅对专用目录使用。

## 4. 没有 Compose 时

先执行第 2 节，然后使用以下命令代替第 3 节。Compose 和 docker run 两种方式选择一种，不要同时启动。

```sh
docker build -t wangpan:1.0.0-arm64 .
docker volume create wangpan-data
docker run -d --name wangpan --restart unless-stopped \
  --env-file .env.docker \
  -p 3000:3000 \
  --mount type=volume,source=wangpan-data,target=/var/lib/wangpan \
  --mount type=bind,source=/srv/wangpan/files,target=/srv/wangpan/files \
  --read-only --tmpfs /tmp --stop-timeout 30 \
  wangpan:1.0.0-arm64
docker logs --tail=100 wangpan
docker inspect --format '{{.State.Health.Status}}' wangpan
```

## 5. 离线导入

在可联网的构建机上，选择与目标服务器一致的平台。以下示例对应本次已确认的 aarch64 服务器：

```sh
docker buildx build --platform linux/arm64 --load -t wangpan:1.0.0-arm64 .
docker save -o wangpan-1.0.0-arm64.tar wangpan:1.0.0-arm64
```

跨架构构建需要构建器具备相应模拟能力，或改用同架构构建机。将镜像文件、`compose.yaml` 和 `deploy/docker.env.example` 复制到麒麟服务器，按第 2 节创建配置和共享目录后执行：

```sh
docker load -i wangpan-1.0.0-arm64.tar
docker image inspect --format '{{.Os}}/{{.Architecture}}' wangpan:1.0.0-arm64
docker compose up -d --no-build --pull never
docker compose ps
```

离线服务器无需源码、npm 或网络下载。没有 Compose 时，导入后执行第 4 节中的 `docker volume create` 和 `docker run` 命令，跳过 `docker build`。

## 6. 现场验证与更新

```sh
curl -I http://127.0.0.1:3000/login
docker compose logs --tail=100 wangpan
```

登录页面应返回 200，容器健康状态应为 healthy。再验证登录、中文文件下载和日志记录，重启容器确认账号和日志保留。健康检查只表示登录页面响应正常，不替代下载和持久化验收。

联网源码更新后执行 `docker compose build` 和 `docker compose up -d --no-build --force-recreate`。离线更新先 `docker load` 导入新镜像，再执行 `docker compose up -d --no-build --pull never --force-recreate`。配置调整后也需重建容器才能加载新的环境变量。

重建时保留 `.env.docker`、`wangpan-data` 数据卷和宿主机共享目录；`docker compose down -v` 会删除数据库卷，不用于普通停止或更新。

## 本次镜像验证

2026-09-14 在本机 Docker Desktop 29.2.0 的 Linux ARM64 容器中完成验证：Node.js 24.21.0，better-sqlite3 13.0.3，现有 15 项集成测试全部通过；容器启动和健康探测、UID 1000、中文共享文件读取、只读挂载、SQLite quick_check，以及删除并重建容器后账号停用状态保留均通过。临时验证容器、数据卷和文件已清理。

导出归档已核对为 linux/arm64，镜像标签为 wangpan:1.0.0-arm64。以上不等于已在目标麒麟内核及 Docker 20.10.24 上验收，现场仍需完成登录、下载和重启检查。

管理员删除要求共享目录可写挂载，且 UID 1000 对相关目录有写入和遍历权限。旧容器修改挂载后需重新创建，操作见 [搜索与删除更新说明](搜索与删除更新说明.md)。
