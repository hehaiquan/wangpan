import session from 'express-session';

/** 将会话持久化到业务 SQLite，并通过账号版本防止已撤销会话被并发请求恢复。 */
export class SQLiteSessionStore extends session.Store {
  /** 保存数据库连接并周期清理过期会话。 */
  constructor(db) {
    super();
    this.db = db;
    this.cleanup = setInterval(() => {
      try {
        this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      } catch (error) {
        console.error('会话清理失败：', error.code || 'DATABASE_ERROR');
      }
    }, 15 * 60 * 1000);
    this.cleanup.unref();
  }

  /** 读取未过期会话。 */
  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?').get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) {
      callback(error);
    }
  }

  /** 写入会话时再次检查账号版本，防止密码修改后的旧请求恢复登录。 */
  set(sid, value, callback = () => {}) {
    try {
      const userId = value.userId ?? null;
      if (userId !== null) {
        const user = this.db.prepare('SELECT enabled, auth_version FROM users WHERE id = ?').get(userId);
        if (!user?.enabled || user.auth_version !== value.authVersion) {
          this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
          return callback();
        }
      }
      const expiresAt = Math.min(new Date(value.cookie.expires).getTime(), value.absoluteExpiresAt || Infinity);
      this.db.prepare('INSERT INTO sessions (sid, user_id, auth_version, expires_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, auth_version = excluded.auth_version, expires_at = excluded.expires_at, data = excluded.data')
        .run(sid, userId, value.authVersion ?? null, expiresAt, JSON.stringify(value));
      callback();
    } catch (error) {
      callback(error);
    }
  }

  /** 使用原有到期时间保存会话，不延长固定的登录有效期。 */
  touch(sid, value, callback) {
    this.set(sid, value, callback);
  }

  /** 删除退出或失效的会话。 */
  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  /** 关闭清理计时器，让服务和测试正常退出。 */
  close() {
    clearInterval(this.cleanup);
  }
}
