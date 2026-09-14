import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hashPassword } from './password.js';

/** 打开业务数据库并创建初版结构，不重写现有账号或历史记录。 */
export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename, { timeout: 5000 });
  fs.chmodSync(filename, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec([
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN (\'admin\', \'user\')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)), auth_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), auth_version INTEGER, expires_at INTEGER NOT NULL, data TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)',
    'CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)',
    'CREATE TABLE IF NOT EXISTS login_logs (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), username TEXT NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL, created_at TEXT NOT NULL, result TEXT NOT NULL CHECK(result IN (\'success\', \'failed\', \'limited\')), reason TEXT)',
    'CREATE INDEX IF NOT EXISTS login_logs_time ON login_logs(created_at DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS login_logs_user_time ON login_logs(username, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS login_logs_ip_time ON login_logs(ip, created_at DESC)',
    'CREATE TABLE IF NOT EXISTS download_logs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), username TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, file_size INTEGER, ip TEXT NOT NULL, user_agent TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, result TEXT NOT NULL CHECK(result IN (\'started\', \'completed\', \'failed\', \'interrupted\')), reason TEXT)',
    'CREATE INDEX IF NOT EXISTS download_logs_time ON download_logs(started_at DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS download_logs_user_time ON download_logs(username, started_at DESC)',
    'CREATE INDEX IF NOT EXISTS download_logs_ip_time ON download_logs(ip, started_at DESC)',
    'PRAGMA user_version = 1'
  ].join(';\n'));
  return db;
}

/** 仅在空账号表中原子创建两个内置账号，重跑不会还原密码或状态。 */
export async function initializeAccounts(db) {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) return false;
  const adminHash = await hashPassword('adminyj@2026');
  const userHash = await hashPassword('yj@2026');
  return db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) return false;
    const insert = db.prepare('INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    insert.run('admin', adminHash, 'admin', now, now);
    insert.run('user', userHash, 'user', now, now);
    return true;
  })();
}

/** 启动时修复未结束的传输记录，并清理已过期会话。 */
export function recoverDatabase(db) {
  db.prepare('UPDATE download_logs SET result = ?, ended_at = ?, reason = ? WHERE result = ?')
    .run('interrupted', new Date().toISOString(), '服务在传输结束前停止', 'started');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}
