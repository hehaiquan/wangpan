import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fixture, Client, waitFor } from './helpers.js';

test('搜索递归查找子目录、显示同名文件路径、统一分页，并限制在当前目录内', async t => {
  const f = await fixture(t, { pageSize: 2 });
  await fs.mkdir(path.join(f.fileRoot, '资料', '深层'), { recursive: true });
  await fs.mkdir(path.join(f.fileRoot, '其他'));
  await fs.mkdir(path.join(f.fileRoot, '资料', '报告文件夹'));
  for (const name of ['资料/报告.txt', '资料/深层/报告.txt', '其他/报告.txt']) {
    await fs.writeFile(path.join(f.fileRoot, name), '正文');
  }
  const client = new Client(f);
  await client.login('user', 'yj@2026');
  const route = '/files?' + new URLSearchParams({ path: '资料', q: '报告' });
  const first = await client.request(route);
  assert.equal(first.status, 200);
  assert.match(first.text, /共 <strong>3<\/strong> 条记录/);
  assert.match(first.text, /包含子目录/);
  assert.match(first.text, /报告文件夹/);
  const second = await client.request(route + '&page=2');
  const combined = first.text + second.text;
  assert.match(combined, /路径：资料\/报告.txt/);
  assert.match(combined, /路径：资料\/深层\/报告.txt/);
  assert.ok(!combined.includes('路径：其他/报告.txt'));
  assert.match(second.text, /q=%E6%8A%A5%E5%91%8A/);
  assert.ok(!(await client.request('/files')).text.includes('>报告.txt</span>'));
  const all = await client.request('/files?q=' + encodeURIComponent('报告'));
  assert.match(all.text, /共 <strong>4<\/strong> 条记录/);
  const uppercase = await client.request('/files?q=TXT');
  assert.match(uppercase.text, /共 <strong>3<\/strong> 条记录/);
});

test('递归搜索跳过越界链接和循环目录链接，子目录不可读时给出提示', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.fileRoot, 'child'));
  await fs.writeFile(path.join(f.fileRoot, 'child', 'match.txt'), 'safe');
  await fs.writeFile(path.join(f.directory, 'match-secret.txt'), 'secret');
  await fs.symlink(f.fileRoot, path.join(f.fileRoot, 'child', 'loop'));
  await fs.symlink(f.directory, path.join(f.fileRoot, 'outside'));
  await fs.symlink(path.join(f.fileRoot, 'child'), path.join(f.fileRoot, 'alias'));
  const client = new Client(f);
  await client.login();
  const result = await client.request('/files?q=match');
  assert.equal(result.status, 200);
  assert.match(result.text, /共 <strong>1<\/strong> 条记录/);
  assert.match(result.text, /路径：child\/match.txt/);
  assert.ok(!result.text.includes('match-secret'));
  if (process.getuid?.() !== 0) {
    const locked = path.join(f.fileRoot, 'locked');
    await fs.mkdir(locked);
    await fs.chmod(locked, 0);
    t.after(() => fs.chmod(locked, 0o700).catch(() => {}));
    const partial = await client.request('/files?q=match');
    assert.equal(partial.status, 200);
    assert.match(partial.text, /有 1 个子目录无法读取/);
  }
});

test('管理员删除中文特殊文件和非空目录，保留搜索上下文并返回成功提示', async t => {
  const f = await fixture(t);
  const name = '资料/季度 <报告> #100%+&.txt';
  await fs.mkdir(path.join(f.fileRoot, '资料', '子目录', '深层'), { recursive: true });
  await fs.writeFile(path.join(f.fileRoot, name), '正文');
  await fs.writeFile(path.join(f.fileRoot, '资料', '子目录', '深层', 'file.txt'), 'nested');
  const client = new Client(f);
  await client.login();
  const listing = await client.request('/files?q=' + encodeURIComponent('季度'));
  assert.match(listing.text, /data-delete-path="资料\/季度 &lt;报告&gt; #100%\+&amp;.txt"/);
  assert.match(listing.text, /id="delete-dialog"/);
  const deleted = await client.post('/admin/files/delete', { path: name, returnPath: '资料', q: '季度', page: '2' });
  assert.equal(deleted.status, 303);
  const location = new URL(deleted.headers.get('location'), f.base);
  assert.equal(location.pathname, '/files');
  assert.equal(location.searchParams.get('path'), '资料');
  assert.equal(location.searchParams.get('q'), '季度');
  assert.equal(location.searchParams.get('page'), '2');
  await assert.rejects(fs.stat(path.join(f.fileRoot, name)), { code: 'ENOENT' });
  assert.match((await client.request(location.pathname + location.search)).text, /删除成功/);
  assert.equal((await client.post('/admin/files/delete', { path: '资料/子目录' })).status, 303);
  await assert.rejects(fs.stat(path.join(f.fileRoot, '资料', '子目录')), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(f.fileRoot, '资料'))).isDirectory());
  assert.equal((await client.post('/admin/files/delete', { path: name })).status, 404);
});

test('删除接口强制管理员权限和 CSRF，普通用户无入口且伪造请求不能删除', async t => {
  const f = await fixture(t);
  const filename = path.join(f.fileRoot, 'safe.txt');
  await fs.writeFile(filename, 'keep');
  const anonymous = new Client(f);
  assert.equal((await anonymous.post('/admin/files/delete', { path: 'safe.txt' })).status, 303);
  const user = new Client(f);
  await user.login('user', 'yj@2026');
  const listing = await user.request('/files');
  assert.ok(!listing.text.includes('data-delete-path'));
  assert.ok(!listing.text.includes('id="delete-dialog"'));
  assert.equal((await user.post('/admin/files/delete', { path: 'safe.txt' })).status, 403);
  const admin = new Client(f);
  await admin.login();
  assert.equal((await admin.post('/admin/files/delete', { path: 'safe.txt', _csrf: '' })).status, 403);
  assert.equal((await admin.request('/admin/files/delete?path=safe.txt')).status, 404);
  assert.equal((await admin.post('/admin/files/delete', { path: 'safe.txt', returnPath: '../' })).status, 403);
  assert.equal((await admin.post('/admin/files/delete', { path: 'safe.txt', page: '-1' })).status, 400);
  f.db.prepare("UPDATE users SET enabled = 0 WHERE username = 'admin'").run();
  assert.equal((await admin.post('/admin/files/delete', { path: 'safe.txt' })).status, 303);
  assert.equal(await fs.readFile(filename, 'utf8'), 'keep');
});

test('删除保护共享根和路径边界，不跟随目录链接，递归删除保留链接目标', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.fileRoot, 'actual'));
  await fs.mkdir(path.join(f.fileRoot, 'remove'));
  await fs.writeFile(path.join(f.fileRoot, 'actual', 'keep.txt'), 'keep');
  await fs.writeFile(path.join(f.directory, 'secret.txt'), 'secret');
  await fs.symlink(path.join(f.fileRoot, 'actual'), path.join(f.fileRoot, 'alias'));
  await fs.symlink(f.directory, path.join(f.fileRoot, 'outside'));
  await fs.symlink(f.directory, path.join(f.fileRoot, 'remove', 'outside'));
  await fs.symlink(path.join(f.fileRoot, 'actual'), path.join(f.fileRoot, 'remove', 'inside'));
  const admin = new Client(f);
  await admin.login();
  for (const [input, status] of [
    ['', 403], ['.', 403], ['actual/..', 403], ['../secret.txt', 403],
    ['/etc/passwd', 400], ['actual\\keep.txt', 400], ['actual\u0000', 400],
    ['alias/keep.txt', 403], ['outside/secret.txt', 403]
  ]) {
    assert.equal((await admin.post('/admin/files/delete', { path: input })).status, status, input);
  }
  assert.equal((await admin.post('/admin/files/delete')).status, 403);
  assert.equal((await admin.post('/admin/files/delete', { path: 'alias' })).status, 303);
  await assert.rejects(fs.lstat(path.join(f.fileRoot, 'alias')), { code: 'ENOENT' });
  assert.equal((await admin.post('/admin/files/delete', { path: 'remove' })).status, 303);
  await assert.rejects(fs.stat(path.join(f.fileRoot, 'remove')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.fileRoot, 'actual', 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(f.directory, 'secret.txt'), 'utf8'), 'secret');
});

test('管理员删除遇到目录不可写时返回明确错误并保留文件', async t => {
  if (process.getuid?.() === 0) return t.skip('root 可绕过 Unix 文件权限');
  const f = await fixture(t);
  const directory = path.join(f.fileRoot, 'locked');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'keep.txt'), 'keep');
  await fs.chmod(directory, 0o500);
  try {
    const admin = new Client(f);
    await admin.login();
    const denied = await admin.post('/admin/files/delete', { path: 'locked/keep.txt' });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /没有删除权限/);
    assert.equal(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await fs.chmod(directory, 0o700);
  }
});

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
