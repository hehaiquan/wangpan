ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    FILE_ROOT=/srv/wangpan/files \
    SQLITE_PATH=/var/lib/wangpan/wangpan.sqlite

WORKDIR /app
COPY package.json package-lock.json ./
# 锁定依赖已带 Linux 原生文件，跳过 npm 隐式 node-gyp，再实际打开 SQLite 验证。
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=info && npm cache clean --force \
    && node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(db.prepare('SELECT 1 AS ok').get()); db.close();"

COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /var/lib/wangpan /srv/wangpan/files \
    && chown node:node /var/lib/wangpan \
    && chmod 0700 /var/lib/wangpan

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "scripts/docker-healthcheck.js"]
CMD ["node", "src/server.js"]
