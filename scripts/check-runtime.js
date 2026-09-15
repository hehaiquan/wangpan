import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);

/** 在目标容器检查原生数据库、密码计算和 HTTP，不接触正式配置或数据卷。 */
async function checkRuntime() {
  assert.equal(process.platform, 'linux');
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wangpan-runtime-'));
  let db;
  let server;
  try {
    const databasePath = path.join(directory, 'probe.sqlite');
    db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES (\'运行检查\');');
    assert.equal(db.prepare('SELECT value FROM probe').get().value, '运行检查');
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    db.close();
    db = new Database(databasePath);
    assert.equal(db.prepare('SELECT value FROM probe').get().value, '运行检查');
    assert.equal((await promisify(scrypt)('runtime-probe', 'temporary-salt', 32)).length, 32);
    // 使用临时回环端口检查 HTTP 和 fetch，不向宿主机发布端口。
    server = http.createServer((request, response) => response.end('runtime-ok'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(await response.text(), 'runtime-ok');
    console.log(JSON.stringify({
      node: process.version, platform: process.platform, arch: process.arch, kernel: os.release(),
      nativeModule: Object.keys(require.cache).find(filename => filename.endsWith('.node'))
    }));
    console.log('运行检查通过：SQLite WAL、文件读写、密码计算、HTTP 和 fetch 正常。');
  } finally {
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    if (db?.open) db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

await checkRuntime();
