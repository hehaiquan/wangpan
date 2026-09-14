import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// 未知用户仍执行同等成本的哈希计算，避免账号存在性影响响应时间。
const dummyHash = 'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(128);

/** 验证密码输入范围，保留用户指定的特殊字符。 */
export function validatePassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

/** 用独立随机盐和 scrypt 生成密码哈希，不保存明文。 */
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64, options);
  return 'scrypt:' + salt + ':' + key.toString('hex');
}

/** 使用固定耗时比较验证密码，未知或损坏的账号哈希返回失败。 */
export async function verifyPassword(password, encoded) {
  const valid = typeof encoded === 'string' && /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded);
  const [, salt, expected] = (valid ? encoded : dummyHash).split(':');
  const key = await deriveKey(typeof password === 'string' ? password : '', salt, 64, options);
  return timingSafeEqual(key, Buffer.from(expected, 'hex')) && valid;
}
