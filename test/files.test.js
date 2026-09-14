import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fixture, Client, waitFor } from './helpers.js';

test('实时目录浏览、文件夹优先、中文筛选、分页、空目录及 HTML 转义', async t => {
  const f = await fixture(t, { pageSize: 2 });
  await fs.mkdir(path.join(f.fileRoot, '资料'));
  await fs.writeFile(path.join(f.fileRoot, 'a.txt'), 'a');
  await fs.writeFile(path.join(f.fileRoot, 'b.txt'), 'bb');
  await fs.writeFile(path.join(f.fileRoot, '中文 <img src=x>.txt'), '正文');
  const client = new Client(f);
  await client.login('user', 'yj@2026');
  const first = await client.request('/files');
  assert.equal(first.status, 200);
  assert.match(first.text, /共 <strong>4<\/strong> 条记录/);
  assert.ok(first.text.indexOf('>资料</a>') < first.text.indexOf('file-icon document-icon'));
  assert.ok(!first.text.includes('>b.txt</span>'));
  const second = await client.request('/files?page=2');
  assert.ok(second.text.includes('>b.txt</span>'));
  const filtered = await client.request('/files?q=' + encodeURIComponent('中文'));
  assert.match(filtered.text, /共 <strong>1<\/strong> 条记录/);
  assert.ok(filtered.text.includes('&lt;img src=x&gt;'));
  assert.ok(!filtered.text.includes('<img src=x>'));
  const empty = await client.request('/files?path=' + encodeURIComponent('资料'));
  assert.ok(empty.text.includes('这个文件夹还是空的'));
  await fs.writeFile(path.join(f.fileRoot, '资料', '最新文件.txt'), 'new');
  const refreshed = await client.request('/files?path=' + encodeURIComponent('资料'));
  assert.ok(refreshed.text.includes('最新文件.txt'));
  assert.ok(refreshed.text.includes('返回上一级'));
  assert.equal((await client.request('/files?page=-1')).status, 400);
  assert.equal((await client.request('/files?path=a.txt')).status, 400);
});

test('认证、目录穿越、绝对路径、编码路径、目录和越界符号链接均不能下载', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.fileRoot, 'inside'));
  const outside = path.join(f.directory, 'private-secret.txt');
  await fs.writeFile(outside, 'PRIVATE-FILE-CONTENT');
  await fs.symlink(outside, path.join(f.fileRoot, 'escape.txt'));
  await fs.symlink(f.directory, path.join(f.fileRoot, 'escape-directory'));
  await fs.writeFile(path.join(f.fileRoot, 'safe.txt'), 'SAFE-CONTENT');
  await fs.symlink(path.join(f.fileRoot, 'safe.txt'), path.join(f.fileRoot, 'safe-link.txt'));
  const anonymous = new Client(f);
  assert.equal((await anonymous.request('/download?path=safe.txt')).status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM download_logs').get().count, 0);
  const client = new Client(f);
  await client.login('user', 'yj@2026');
  for (const [input, status] of [
    ['../private-secret.txt', 403], ['/etc/passwd', 400],
    ['escape.txt', 403], ['escape-directory/private-secret.txt', 403],
    ['inside', 400], ['not-here.txt', 404], ['..\\private-secret.txt', 400], ['safe.txt\u0000', 400]
  ]) {
    const result = await client.request('/download?path=' + encodeURIComponent(input));
    assert.equal(result.status, status, input);
    assert.ok(!result.text.includes('PRIVATE-FILE-CONTENT'));
  }
  assert.equal((await client.request('/download?path=%252e%252e%252fprivate-secret.txt')).status, 404);
  const listing = await client.request('/files');
  assert.ok(!listing.text.includes('escape.txt'));
  assert.ok(!listing.text.includes('escape-directory'));
  const linked = await client.request('/download?path=safe-link.txt');
  assert.equal(linked.status, 200);
  assert.equal(linked.text, 'SAFE-CONTENT');
  await waitFor(() => f.db.prepare("SELECT COUNT(*) AS count FROM download_logs WHERE result = 'started'").get().count === 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM download_logs WHERE result = 'failed'").get().count, 9);
  assert.equal((await client.request('/files?path=' + encodeURIComponent('../'))).status, 403);
});

test('中文特殊文件名、空文件、内容一致及整文件下载结果准确落库', async t => {
  const f = await fixture(t, { trustProxy: ['loopback'] });
  const name = '季度 报告 #100%+&.txt';
  const bytes = Buffer.from('中文内容\n\x00\x01\xff');
  await fs.writeFile(path.join(f.fileRoot, name), bytes);
  await fs.writeFile(path.join(f.fileRoot, 'empty.bin'), '');
  const client = new Client(f);
  await client.login('user', 'yj@2026');
  const download = await client.request('/download?path=' + encodeURIComponent(name), {
    headers: { Range: 'bytes=0-2', 'X-Forwarded-For': '203.0.113.15', 'User-Agent': 'Download test' }
  });
  assert.equal(download.status, 200);
  assert.deepEqual(download.buffer, bytes);
  assert.equal(download.headers.get('content-length'), String(bytes.length));
  assert.equal(download.headers.get('accept-ranges'), 'none');
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.match(download.headers.get('content-disposition'), /attachment;/);
  assert.ok(download.headers.get('content-disposition').includes("filename*=UTF-8''"));
  const log = await waitFor(() => f.db.prepare("SELECT * FROM download_logs WHERE result = 'completed'").get());
  assert.equal(log.username, 'user');
  assert.equal(log.relative_path, name);
  assert.equal(log.file_size, bytes.length);
  assert.equal(log.ip, '203.0.113.15');
  assert.equal(log.user_agent, 'Download test');
  assert.ok(log.ended_at >= log.started_at);
  const empty = await client.request('/download?path=empty.bin');
  assert.equal(empty.status, 200);
  assert.equal(empty.buffer.length, 0);
  await waitFor(() => f.db.prepare("SELECT COUNT(*) AS count FROM download_logs WHERE result = 'completed'").get().count === 2);
  assert.equal((await client.request('/download?path=empty.bin', { method: 'HEAD' })).status, 405);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM download_logs').get().count, 2);
});

test('下载开始记录写入失败时不返回文件内容，文件已删除时记录失败', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.fileRoot, 'sample.txt'), 'DOWNLOAD MUST NOT START');
  const client = new Client(f);
  await client.login();
  f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON download_logs BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END");
  const blocked = await client.request('/download?path=sample.txt');
  assert.equal(blocked.status, 503);
  assert.ok(!blocked.text.includes('DOWNLOAD MUST NOT START'));
  assert.ok(!blocked.headers.get('content-disposition'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM download_logs').get().count, 0);
  f.db.exec('DROP TRIGGER reject_audit');
  await fs.unlink(path.join(f.fileRoot, 'sample.txt'));
  assert.equal((await client.request('/download?path=sample.txt')).status, 404);
  assert.equal(f.db.prepare('SELECT result FROM download_logs').get().result, 'failed');
});

test('大文件使用流式发送，客户端断开后记录中断，重启修复遗留传输', async t => {
  const f = await fixture(t);
  const handle = await fs.open(path.join(f.fileRoot, 'large.bin'), 'w');
  await handle.truncate(128 * 1024 * 1024);
  await handle.close();
  const client = new Client(f);
  await client.login('user', 'yj@2026');
  await new Promise((resolve, reject) => {
    const request = http.get(f.base + '/download?path=large.bin', { headers: { Cookie: client.cookie } }, response => {
      assert.equal(response.statusCode, 200);
      response.once('data', () => { response.destroy(); resolve(); });
      response.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    request.on('error', reject);
  });
  const interrupted = await waitFor(() => f.db.prepare("SELECT * FROM download_logs WHERE result = 'interrupted'").get());
  assert.equal(interrupted.file_size, 128 * 1024 * 1024);
  assert.ok(interrupted.ended_at);
  f.db.prepare("INSERT INTO download_logs (user_id, username, file_name, relative_path, ip, user_agent, started_at, result) VALUES (2, 'user', 'unfinished.bin', 'unfinished.bin', '127.0.0.1', '', ?, 'started')").run(new Date().toISOString());
  await f.stop();
  await f.start();
  const recovered = f.db.prepare("SELECT * FROM download_logs WHERE file_name = 'unfinished.bin'").get();
  assert.equal(recovered.result, 'interrupted');
  assert.equal(recovered.reason, '服务在传输结束前停止');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM download_logs').get().count, 2);
});

test('无读取权限的文件或目录不会输出内容', async t => {
  if (process.getuid?.() === 0) return t.skip('root 可绕过 Unix 文件权限，本用例需以普通用户运行');
  const f = await fixture(t);
  const filename = path.join(f.fileRoot, 'unreadable.txt');
  const dirname = path.join(f.fileRoot, 'locked');
  await fs.writeFile(filename, 'unreadable-content');
  await fs.mkdir(dirname);
  await fs.chmod(filename, 0);
  await fs.chmod(dirname, 0);
  t.after(async () => {
    await fs.chmod(filename, 0o600).catch(() => {});
    await fs.chmod(dirname, 0o700).catch(() => {});
  });
  const client = new Client(f);
  await client.login();
  const download = await client.request('/download?path=unreadable.txt');
  assert.equal(download.status, 403);
  assert.ok(!download.text.includes('unreadable-content'));
  assert.equal((await client.request('/files?path=locked')).status, 403);
});
