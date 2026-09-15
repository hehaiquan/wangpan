import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline, Readable } from 'node:stream';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { create as contentDisposition } from 'content-disposition';
import { projectRoot } from './config.js';
import { openDatabase, initializeAccounts, recoverDatabase } from './database.js';
import { SQLiteSessionStore } from './session-store.js';
import { hashPassword, validatePassword, verifyPassword } from './password.js';
import { AppError } from './errors.js';
import { listDirectory, openDownload, fileError, deleteEntry, normalizeRelativePath } from './files.js';
import { formatTime, formatSize, linkTo, pageNumber, queryText, queryLogs, resultLabels } from './view-helpers.js';

const COOKIE_NAME = 'wangpan.sid';
const notices = {
  deleted: '删除成功',
  created: '账号已创建', password: '密码已修改，该账号需重新登录',
  enabled: '账号已启用', disabled: '账号已禁用，已有会话已撤销',
  relogin: '密码已修改，请使用新密码登录', expired: '登录已失效，请重新登录'
};

/** 获取经过 Express 可信代理配置解析后的客户端地址。 */
function clientIP(req) {
  return (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
}

/** 获取审计使用的请求元数据，不记录密码、Cookie 或完整请求正文。 */
function metadata(req) {
  return { ip: clientIP(req), userAgent: (req.get('user-agent') || '').slice(0, 512) };
}

/** 对有效会话执行固定时长控制，并安全删除失效登录。 */
async function destroySession(req, res, secure) {
  await promisify(req.session.destroy).call(req.session);
  res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure });
}

/** 限制登录后资源访问，下载接口直接报告未认证状态。 */
function requireAuth(req, res, next) {
  if (res.locals.currentUser) return next();
  if (req.path === '/download') return next(new AppError(401, '请先登录后下载文件'));
  res.redirect(303, '/login');
}

/** 对管理操作执行服务端角色检查，普通用户即使操作自己也无权限。 */
function requireAdmin(req, res, next) {
  if (res.locals.currentUser?.role !== 'admin') return next(new AppError(403, '此操作仅允许管理员执行'));
  next();
}

/** 验证表单 CSRF 令牌，使用固定耗时比较避免时序泄露。 */
function verifyCSRF(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const submitted = req.body?._csrf;
  const expected = req.session?.csrf;
  if (typeof submitted !== 'string' || !/^[a-f0-9]{64}$/.test(submitted) || typeof expected !== 'string' || submitted.length !== expected.length ||
      !timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
    return next(new AppError(403, '页面已失效，请刷新后重新提交'));
  }
  next();
}

/** 校验并读取管理操作的目标账号。 */
function targetUser(db, id) {
  if (!/^[1-9]\d*$/.test(id)) throw new AppError(400, '账号编号无效');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new AppError(404, '账号不存在');
  return user;
}

/** 创建可独立测试的应用实例，统一管理数据库、会话和活动下载。 */
export async function createApp(config) {
  const db = openDatabase(config.databasePath);
  try {
    await initializeAccounts(db);
    recoverDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const store = new SQLiteSessionStore(db);
  const activeDownloads = new Set();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));
  app.locals = { ...app.locals, formatTime, formatSize, linkTo, resultLabels };
  app.use(helmet({
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': config.secureCookie ? [] : null, 'form-action': ["'self'"] } },
    strictTransportSecurity: config.secureCookie ? undefined : false
  }));
  app.use('/assets', express.static(path.join(projectRoot, 'public'), { maxAge: '1h', dotfiles: 'deny', index: false }));
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }));
  app.use(session({
    name: COOKIE_NAME, secret: config.sessionSecret, store,
    resave: false, saveUninitialized: false, rolling: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookie, maxAge: config.sessionMs }
  }));
  app.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.locals.currentUser = null;
    res.locals.activePage = '';
    res.locals.notice = notices[typeof req.query.notice === 'string' ? req.query.notice : ''] || '';
    if (req.session.userId) {
      const user = db.prepare('SELECT id, username, role, enabled, auth_version FROM users WHERE id = ?').get(req.session.userId);
      if (!user?.enabled || user.auth_version !== req.session.authVersion || req.session.absoluteExpiresAt <= Date.now()) {
        await destroySession(req, res, config.secureCookie);
        return res.redirect(303, '/login?notice=expired');
      }
      res.locals.currentUser = user;
      req.session.cookie.maxAge = req.session.absoluteExpiresAt - Date.now();
    }
    if (!req.session.csrf) req.session.csrf = randomBytes(32).toString('hex');
    res.locals.csrf = req.session.csrf;
    next();
  });
  app.use('/admin', requireAuth, requireAdmin);
  app.use(verifyCSRF);

  app.get('/', (req, res) => res.redirect(303, res.locals.currentUser ? '/files' : '/login'));
  app.get('/login', (req, res) => {
    if (res.locals.currentUser) return res.redirect(303, '/files');
    res.render('login', { title: '登录', error: '', username: '' });
  });
  app.post('/login', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim().slice(0, 64) : '';
    const password = req.body.password;
    const { ip, userAgent } = metadata(req);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const accountAttempts = db.prepare("SELECT COUNT(*) AS count FROM login_logs WHERE username = ? AND ip = ? AND created_at >= ? AND result != 'success'").get(username, ip, cutoff).count;
    const ipAttempts = db.prepare("SELECT COUNT(*) AS count FROM login_logs WHERE ip = ? AND created_at >= ? AND result != 'success'").get(ip, cutoff).count;
    const insertLog = db.prepare('INSERT INTO login_logs (user_id, username, ip, user_agent, created_at, result, reason) VALUES (?, ?, ?, ?, ?, ?, ?)');
    if (accountAttempts >= (config.loginMaxAttempts ?? 10) || ipAttempts >= 100) {
      insertLog.run(user?.id ?? null, username, ip, userAgent, new Date().toISOString(), 'limited', '15 分钟内登录失败次数过多');
      res.set('Retry-After', '900');
      return res.status(429).render('login', { title: '登录', error: '尝试次数过多，请 15 分钟后再试', username });
    }
    const correct = await verifyPassword(typeof password === 'string' && password.length <= 128 ? password : '', user?.password_hash);
    // 哈希校验期间账号可能被禁用或修改密码，因此创建会话前重新检查版本。
    const latest = user && db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const valid = correct && latest?.enabled && latest.auth_version === user.auth_version;
    if (!valid) {
      const reason = !user ? '账号不存在' : !latest?.enabled ? '账号已禁用' : '密码错误或已更新';
      insertLog.run(user?.id ?? null, username, ip, userAgent, new Date().toISOString(), 'failed', reason);
      return res.status(401).render('login', { title: '登录', error: '账号或密码错误，或账号已停用', username });
    }
    await promisify(req.session.regenerate).call(req.session);
    req.session.userId = latest.id;
    req.session.authVersion = latest.auth_version;
    req.session.absoluteExpiresAt = Date.now() + config.sessionMs;
    req.session.cookie.maxAge = config.sessionMs;
    req.session.csrf = randomBytes(32).toString('hex');
    try {
      insertLog.run(latest.id, username, ip, userAgent, new Date().toISOString(), 'success', null);
      await promisify(req.session.save).call(req.session);
    } catch (error) {
      await destroySession(req, res, config.secureCookie);
      throw new AppError(503, '登录记录暂时无法保存，请稍后重试');
    }
    res.redirect(303, '/files');
  });
  app.post('/logout', requireAuth, async (req, res) => {
    await destroySession(req, res, config.secureCookie);
    res.redirect(303, '/login');
  });
  app.get('/files', requireAuth, async (req, res) => {
    const query = queryText(req.query.q);
    const listing = await listDirectory(config.fileRoot, req.query.path ?? '', query, pageNumber(req.query.page), config.pageSize);
    res.render('files', { title: '文件空间', activePage: 'files', listing, query });
  });

  // /admin 中间件和全局 CSRF 校验共同保护删除接口，回跳参数在删除前完成校验。
  app.post('/admin/files/delete', async (req, res) => {
    const returnPath = normalizeRelativePath(req.body.returnPath ?? '');
    const query = queryText(req.body.q);
    const page = pageNumber(req.body.page);
    await deleteEntry(config.fileRoot, req.body.path);
    res.redirect(303, linkTo('/files', { path: returnPath, q: query, page, notice: 'deleted' }));
  });

  app.get('/download', requireAuth, async (req, res, next) => {
    if (req.method === 'HEAD') return res.set('Allow', 'GET').status(405).end();
    const requested = typeof req.query.path === 'string' ? req.query.path.slice(0, 4096) : '';
    const { ip, userAgent } = metadata(req);
    let logId;
    try {
      logId = db.prepare('INSERT INTO download_logs (user_id, username, file_name, relative_path, ip, user_agent, started_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(res.locals.currentUser.id, res.locals.currentUser.username, path.posix.basename(requested), requested, ip, userAgent, new Date().toISOString(), 'started').lastInsertRowid;
    } catch (error) {
      throw new AppError(503, '下载记录暂时无法保存，请稍后重试');
    }
    let finished = false;
    /** 对同一下载只记录一次终态，数据库失败时保留进行中记录供启动修复。 */
    function finish(result, reason = null) {
      if (finished) return;
      finished = true;
      try {
        db.prepare("UPDATE download_logs SET result = ?, ended_at = ?, reason = ? WHERE id = ? AND result = 'started'")
          .run(result, new Date().toISOString(), reason, logId);
      } catch (error) {
        console.error('下载结果保存失败，记录编号：', logId, error.code || 'DATABASE_ERROR');
      }
    }
    let target;
    try {
      target = await openDownload(config.fileRoot, req.query.path);
      db.prepare('UPDATE download_logs SET file_name = ?, relative_path = ?, file_size = ? WHERE id = ?')
        .run(path.posix.basename(target.relative), target.relative, target.stat.size, logId);
      if (req.aborted || res.destroyed) {
        await target.handle.close();
        finish('interrupted', '客户端在传输开始前断开连接');
        return;
      }
      res.status(200).set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(path.posix.basename(target.relative)),
        'Content-Length': String(target.stat.size),
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-store'
      });
      if (target.stat.size === 0) await target.handle.close();
      const stream = target.stat.size === 0 ? Readable.from([]) : target.handle.createReadStream({ start: 0, end: target.stat.size - 1 });
      let bytesRead = 0;
      stream.on('data', chunk => { bytesRead += chunk.length; });
      const entry = { stream, res };
      activeDownloads.add(entry);
      pipeline(stream, res, error => {
        activeDownloads.delete(entry);
        if (!error && res.writableFinished && bytesRead === target.stat.size) finish('completed');
        else if (['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ECONNABORTED'].includes(error?.code)) finish('interrupted', '连接在传输结束前关闭');
        else finish('failed', '文件传输失败');
      });
    } catch (error) {
      if (target?.handle) await target.handle.close().catch(() => {});
      const failure = fileError(error);
      finish('failed', failure.message);
      next(failure);
    }
  });

  app.get('/admin/users', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
    const pages = Math.max(1, Math.ceil(total / config.pageSize));
    const page = Math.min(pageNumber(req.query.page), pages);
    const users = db.prepare('SELECT id, username, role, enabled, created_at, updated_at FROM users ORDER BY id LIMIT ? OFFSET ?').all(config.pageSize, (page - 1) * config.pageSize);
    res.render('users', { title: '用户管理', activePage: 'users', users, total, pages, page });
  });
  app.post('/admin/users', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{2,32}$/.test(username)) throw new AppError(400, '用户名需为 2–32 位中文、字母、数字、下划线或短横线');
    if (!['admin', 'user'].includes(req.body.role)) throw new AppError(400, '账号角色无效');
    if (!validatePassword(req.body.password)) throw new AppError(400, '密码需为 6–128 个字符');
    const passwordHash = await hashPassword(req.body.password);
    // 异步哈希完成后再次确认操作者仍为有效管理员。
    const actor = db.prepare('SELECT enabled, role, auth_version FROM users WHERE id = ?').get(res.locals.currentUser.id);
    if (!actor?.enabled || actor.role !== 'admin' || actor.auth_version !== req.session.authVersion) throw new AppError(403, '管理员登录已失效，请重新登录');
    const now = new Date().toISOString();
    try {
      db.prepare('INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(username, passwordHash, req.body.role, now, now);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new AppError(409, '用户名已存在');
      throw error;
    }
    res.redirect(303, '/admin/users?notice=created');
  });
  app.post('/admin/users/:id/status', async (req, res) => {
    if (!['0', '1'].includes(req.body.enabled)) throw new AppError(400, '账号状态无效');
    const enabled = Number(req.body.enabled);
    const user = db.transaction(() => {
      const target = targetUser(db, req.params.id);
      if (!enabled && target.enabled && target.role === 'admin' && db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1").get().count <= 1) {
        throw new AppError(409, '不能禁用最后一个可用管理员');
      }
      if (target.enabled !== enabled) {
        db.prepare('UPDATE users SET enabled = ?, auth_version = auth_version + 1, updated_at = ? WHERE id = ?').run(enabled, new Date().toISOString(), target.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      }
      return target;
    })();
    if (!enabled && user.id === res.locals.currentUser.id) {
      await destroySession(req, res, config.secureCookie);
      return res.redirect(303, '/login');
    }
    res.redirect(303, '/admin/users?notice=' + (enabled ? 'enabled' : 'disabled'));
  });
  app.post('/admin/users/:id/password', async (req, res) => {
    if (!validatePassword(req.body.password)) throw new AppError(400, '密码需为 6–128 个字符');
    const target = targetUser(db, req.params.id);
    const passwordHash = await hashPassword(req.body.password);
    db.transaction(() => {
      const actor = db.prepare('SELECT enabled, role, auth_version FROM users WHERE id = ?').get(res.locals.currentUser.id);
      if (!actor?.enabled || actor.role !== 'admin' || actor.auth_version !== req.session.authVersion) throw new AppError(403, '管理员登录已失效，请重新登录');
      db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1, updated_at = ? WHERE id = ?')
        .run(passwordHash, new Date().toISOString(), target.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    })();
    if (target.id === res.locals.currentUser.id) {
      await destroySession(req, res, config.secureCookie);
      return res.redirect(303, '/login?notice=relogin');
    }
    res.redirect(303, '/admin/users?notice=password');
  });
  app.get('/admin/login-logs', (req, res) => {
    res.render('logs', { title: '登录记录', activePage: 'login-logs', type: 'login', ...queryLogs(db, 'login', req.query, config.pageSize) });
  });
  app.get('/admin/download-logs', (req, res) => {
    res.render('logs', { title: '下载记录', activePage: 'download-logs', type: 'download', ...queryLogs(db, 'download', req.query, config.pageSize) });
  });
  app.use((req, res, next) => next(new AppError(404, '页面不存在')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof AppError ? error.status : (['entity.too.large', 'parameters.too.many'].includes(error.type) ? 413 : 500);
    if (status >= 500) console.error('请求处理失败：', error.code || error.name || 'UNKNOWN_ERROR');
    res.status(status).render('error', {
      title: '请求未完成', status,
      message: error instanceof AppError ? error.message : status === 413 ? '提交内容过大' : '服务暂时无法处理请求，请稍后重试',
      currentUser: res.locals.currentUser || null, activePage: '', csrf: res.locals.csrf || '', notice: ''
    });
  });

  /** 终止仍在进行的下载并关闭 SQLite，供停机和测试释放资源。 */
  async function close() {
    for (const entry of activeDownloads) entry.res.destroy();
    if (activeDownloads.size) await new Promise(resolve => setTimeout(resolve, 50));
    store.close();
    db.close();
  }
  return { app, db, store, close };
}
