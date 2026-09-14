import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectRoot } from '../src/config.js';

/** 生成本地配置与空共享目录；已有配置保持原样。 */
function setup() {
  fs.mkdirSync(path.join(projectRoot, 'storage'), { recursive: true });
  const target = path.join(projectRoot, '.env');
  if (fs.existsSync(target)) {
    console.log('.env 已存在，保持原配置不变。');
    return;
  }
  const example = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
  const content = example.replace('replace-with-a-random-secret-at-least-32-characters', randomBytes(48).toString('hex'));
  fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  console.log('已生成 .env 和 storage 目录；可修改 FILE_ROOT 后执行 npm run init-db 和 npm start。');
}

setup();
