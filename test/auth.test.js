import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, Client } from './helpers.js';
import { initializeAccounts } from '../src/database.js';
import { hashPassword, verifyPassword } from '../src/password.js';

test('内置双账号默认密码正确，重复初始化及重启不会恢复密码或状态', async t => {
  const f = await fixture(t);
  const users = f.db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.deepEqual(users.map(user => [user.username, user.role]), [['admin', 'admin'], ['user', 'user']]);
  assert.equal(await verifyPassword('adminyj@2026', users[0].password_hash), true);
  assert.equal(await verifyPassword('yj@2026', users[1].password_hash), true);
  assert.ok(!users[0].password_hash.includes('adminyj@2026'));
  const hash = await hashPassword('changed@2026');
  f.db.prepare('UPDATE users SET password_hash = ?, enabled = 0 WHERE username = ?').run(hash, 'user');
  assert.equal(await initializeAccounts(f.db), false);
  await f.stop();
  await f.start();
  const persisted = f.db.prepare("SELECT * FROM users WHERE username = 'user'").get();
  assert.equal(persisted.password_hash, hash);
  assert.equal(persisted.enabled, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
});

test('普通用户无密码入口，修改本人或管理员密码、查日志和管理账号均被拒绝', async t => {
  const f = await fixture(t);
  const user = new Client(f);
  assert.equal((await user.login('user', 'yj@2026')).status, 303);
  const page = await user.request('/files');
  assert.ok(!page.text.includes('修改密码'));
  assert.ok(!page.text.includes('/admin/users'));
  for (const route of ['/admin/users', '/admin/login-logs', '/admin/download-logs']) assert.equal((await user.request(route)).status, 403);
  for (const id of [1, 2]) assert.equal((await user.post('/admin/users/' + id + '/password', { password: 'hacked@2026' })).status, 403);
  assert.equal((await user.post('/admin/users/2/status', { enabled: '0' })).status, 403);
  assert.equal((await user.post('/admin/users', { username: 'hacker', password: 'hacked@2026', role: 'admin' })).status, 403);
  assert.equal((await user.post('/account/password', { password: 'hacked@2026' })).status, 404);
  assert.equal((await new Client(f).login('user', 'yj@2026')).status, 303);
  assert.equal((await new Client(f).login('admin', 'adminyj@2026')).status, 303);
});

test('管理员修改密码撤销全部旧会话，修改本人密码后必须重新登录', async t => {
  const f = await fixture(t);
  const admin = new Client(f);
  const user1 = new Client(f);
  const user2 = new Client(f);
  await admin.login();
  await user1.login('user', 'yj@2026');
  await user2.login('user', 'yj@2026');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = 2').get().count, 2);
  const staleRow = f.db.prepare('SELECT * FROM sessions WHERE user_id = 2 LIMIT 1').get();
  assert.equal((await admin.post('/admin/users/2/password', { password: 'freshuser@2026' })).status, 303);
  // 模拟正在收尾的旧请求再次保存会话，验证撤销不会被并发写入绕过。
  await new Promise((resolve, reject) => f.service.store.set(staleRow.sid, JSON.parse(staleRow.data), error => error ? reject(error) : resolve()));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = 2').get().count, 0);
  assert.equal((await user1.request('/files')).status, 303);
  assert.equal((await user2.request('/files')).status, 303);
  assert.equal((await new Client(f).login('user', 'yj@2026')).status, 401);
  assert.equal((await new Client(f).login('user', 'freshuser@2026')).status, 303);
  assert.equal((await admin.post('/admin/users/1/password', { password: 'freshadmin@2026' })).headers.get('location'), '/login?notice=relogin');
  assert.equal((await admin.request('/admin/users')).status, 303);
  await f.stop();
  await f.start();
  assert.equal((await new Client(f).login('admin', 'adminyj@2026')).status, 401);
  assert.equal((await new Client(f).login('admin', 'freshadmin@2026')).status, 303);
});

test('管理员创建账号、唯一用户名、启停账号和最后一个管理员保护', async t => {
  const f = await fixture(t);
  const admin = new Client(f);
  await admin.login();
  assert.equal((await admin.post('/admin/users/1/status', { enabled: '0' })).status, 409);
  assert.equal((await admin.post('/admin/users', { username: 'test-user', password: 'hello@2026', role: 'user' })).status, 303);
  assert.equal((await admin.post('/admin/users', { username: 'test-user', password: 'hello@2026', role: 'user' })).status, 409);
  assert.equal((await admin.post('/admin/users', { username: 'bad', password: '123', role: 'user' })).status, 400);
  const user = new Client(f);
  await user.login('test-user', 'hello@2026');
  const id = f.db.prepare("SELECT id FROM users WHERE username = 'test-user'").get().id;
  assert.equal((await admin.post('/admin/users/' + id + '/status', { enabled: '0' })).status, 303);
  assert.equal((await user.request('/files')).status, 303);
  assert.equal((await new Client(f).login('test-user', 'hello@2026')).status, 401);
  assert.equal((await admin.post('/admin/users/' + id + '/status', { enabled: '1' })).status, 303);
  assert.equal((await new Client(f).login('test-user', 'hello@2026')).status, 303);
  await admin.post('/admin/users', { username: 'another-admin', password: 'hello@2026', role: 'admin' });
  assert.equal((await admin.post('/admin/users/1/status', { enabled: '0' })).headers.get('location'), '/login');
});

test('CSRF 防护、Cookie 属性、退出、固定会话到期及重启持久化', async t => {
  const f = await fixture(t);
  const client = new Client(f);
  const page = await client.request('/login');
  const cookie = page.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal((await client.post('/login', { username: 'admin', password: 'adminyj@2026', _csrf: '' })).status, 403);
  assert.equal((await client.post('/login', { username: 'admin', password: 'adminyj@2026', _csrf: '汉'.repeat(64) })).status, 403);
  await client.login();
  const session = f.db.prepare('SELECT * FROM sessions WHERE user_id = 1').get();
  const absoluteExpiry = JSON.parse(session.data).absoluteExpiresAt;
  await client.request('/files');
  assert.ok(f.db.prepare('SELECT expires_at FROM sessions WHERE user_id = 1').get().expires_at <= absoluteExpiry);
  await f.stop();
  await f.start();
  assert.equal((await client.request('/admin/users')).status, 200);
  assert.equal((await client.post('/logout')).status, 303);
  assert.equal((await client.request('/files')).status, 303);
  await client.login();
  f.db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = 1').run(Date.now() - 1);
  assert.equal((await client.request('/files')).status, 303);
});

test('登录成功、失败和限流均记录；不信任未经授权的代理头', async t => {
  const f = await fixture(t, { loginMaxAttempts: 2 });
  const client = new Client(f);
  const headers = { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'Wangpan audit test' };
  await client.login('not-exists', 'wrongpass', headers);
  await client.login('user', 'wrongpass', headers);
  await client.login('user', 'wrongpass', headers);
  assert.equal((await client.login('user', 'yj@2026', headers)).status, 429);
  assert.equal((await new Client(f).login()).status, 303);
  const rows = f.db.prepare('SELECT * FROM login_logs ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.result), ['failed', 'failed', 'failed', 'limited', 'success']);
  assert.equal(rows[0].username, 'not-exists');
  assert.equal(rows[0].user_id, null);
  assert.equal(rows[0].ip, '127.0.0.1');
  assert.equal(rows[0].user_agent, 'Wangpan audit test');
  assert.match(rows[0].created_at, /Z$/);
  assert.ok(!JSON.stringify(rows).includes('wrongpass'));
  assert.ok(!JSON.stringify(rows).includes('adminyj@2026'));
});

test('可信代理读取邻近的不可信地址，并支持安全 Cookie', async t => {
  const f = await fixture(t, { trustProxy: ['loopback'] });
  await new Client(f).login('user', 'yj@2026', { 'X-Forwarded-For': '198.51.100.4, 203.0.113.8' });
  assert.equal(f.db.prepare('SELECT ip FROM login_logs').get().ip, '203.0.113.8');
  await f.stop();
  f.config.secureCookie = true;
  await f.start();
  const page = await new Client(f).request('/login', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(page.headers.get('set-cookie'), /; Secure/);
});
