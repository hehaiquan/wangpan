import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/** 使用独立临时目录和真实 SQLite 创建 HTTP 测试服务。 */
export async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wangpan-test-'));
  const fileRoot = path.join(directory, 'files');
  await fs.mkdir(fileRoot);
  const config = {
    ...loadConfig({
      FILE_ROOT: fileRoot, SQLITE_PATH: path.join(directory, 'private', 'test.sqlite'),
      SESSION_SECRET: 'a-separate-test-secret-with-at-least-32-characters',
      TRUST_PROXY: 'false', COOKIE_SECURE: 'false'
    }), ...options
  };
  let service;
  let server;
  const state = { directory, config, fileRoot };
  /** 启动或重新启动服务，使客户端可以验证跨进程会话持久化。 */
  state.start = async function start() {
    service = await createApp(config);
    server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    state.service = service;
    state.db = service.db;
    state.base = 'http://127.0.0.1:' + server.address().port;
  };
  /** 关闭连接及数据库，保证临时文件可安全删除。 */
  state.stop = async function stop() {
    if (!server) return;
    const closing = new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    server.closeAllConnections();
    await closing;
    await service.close();
    server = null;
  };
  t.after(async () => {
    await state.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await state.start();
  return state;
}

/** 模拟独立浏览器 Cookie 容器，并保留重定向响应供权限断言。 */
export class Client {
  /** 绑定测试服务，账号之间不共享 Cookie。 */
  constructor(state) {
    this.state = state;
    this.cookie = '';
    this.csrf = '';
  }

  /** 发送真实 HTTP 请求，收集会话 Cookie、CSRF 和返回内容。 */
  async request(route, options = {}) {
    const headers = { ...options.headers };
    if (this.cookie) headers.Cookie = this.cookie;
    const response = await fetch(this.state.base + route, { ...options, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      if (cookie.startsWith('wangpan.sid=')) this.cookie = cookie.split(';')[0];
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    const token = text.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
    if (token) this.csrf = token;
    return { response, status: response.status, headers: response.headers, text, buffer };
  }

  /** 带当前会话 CSRF 提交普通表单。 */
  async post(route, fields = {}, headers = {}) {
    return this.request(route, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ _csrf: this.csrf, ...fields })
    });
  }

  /** 完成登录前页面访问和账号提交，模拟真实浏览器流程。 */
  async login(username = 'admin', password = 'adminyj@2026', headers = {}) {
    await this.request('/login', { headers });
    const result = await this.post('/login', { username, password }, headers);
    if (result.status === 303) await this.request('/files');
    return result;
  }
}

/** 等待异步下载回调持久化，避免把响应接收完成等同于数据库已更新。 */
export async function waitFor(check, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('等待条件超时');
}
