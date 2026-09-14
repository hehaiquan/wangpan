import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取项目的环境文件，不覆盖进程中已设置的环境变量。 */
export function loadEnvironment() {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

/** 判断目标是否位于目录内部，避免把同名前缀目录误判为子目录。 */
export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** 解析已有祖先的真实路径，兼容尚未创建的数据库文件或目录。 */
export function prospectiveRealPath(target) {
  if (fs.existsSync(target)) return fs.realpathSync(target);
  const parent = path.dirname(target);
  if (parent === target) return target;
  return path.join(prospectiveRealPath(parent), path.basename(target));
}

/** 校验整数配置，拒绝无效端口、超长会话等错误输入。 */
function integer(value, fallback, min, max, name) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(name + ' 配置无效');
  return result;
}

/** 只允许明确的代理地址或网段，禁止无条件信任客户端转发头。 */
function parseTrustProxy(value) {
  if (!value || value === 'false') return false;
  const entries = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!entries.length || entries.some(entry => {
    if (entry === 'loopback') return false;
    const parts = entry.split('/');
    const family = net.isIP(parts[0]);
    if (!family || parts.length > 2) return true;
    return parts.length === 2 && (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > (family === 4 ? 32 : 128));
  })) throw new Error('TRUST_PROXY 必须为 false、loopback 或明确的 IP/CIDR 列表');
  return entries;
}

/** 加载并检查运行配置，确保可下载目录不包含数据库或应用配置。 */
export function loadConfig(environment = process.env) {
  if (!environment.FILE_ROOT) throw new Error('请配置 FILE_ROOT，或先运行 npm run setup');
  const fileRoot = fs.realpathSync(path.resolve(projectRoot, environment.FILE_ROOT));
  if (!fs.statSync(fileRoot).isDirectory()) throw new Error('FILE_ROOT 必须是目录');
  fs.accessSync(fileRoot, fs.constants.R_OK | fs.constants.X_OK);
  const databasePath = prospectiveRealPath(path.resolve(projectRoot, environment.SQLITE_PATH || './data/wangpan.sqlite'));
  const protectedPaths = [projectRoot, path.join(projectRoot, '.env'), path.join(projectRoot, '.env.example'), databasePath, path.dirname(databasePath)];
  if (protectedPaths.some(target => isInside(fileRoot, prospectiveRealPath(target)))) {
    throw new Error('FILE_ROOT 不能包含项目、配置或数据库目录');
  }
  const sessionSecret = environment.SESSION_SECRET || '';
  if (sessionSecret.length < 32 || sessionSecret.startsWith('replace-with-')) throw new Error('SESSION_SECRET 必须为至少 32 字符的独立随机密钥');
  const cookieValue = environment.COOKIE_SECURE ?? (environment.NODE_ENV === 'production' ? 'true' : 'false');
  if (!['true', 'false'].includes(cookieValue)) throw new Error('COOKIE_SECURE 只能为 true 或 false');
  return {
    fileRoot,
    databasePath,
    sessionSecret,
    host: environment.HOST || '127.0.0.1',
    port: integer(environment.PORT, 3000, 1, 65535, 'PORT'),
    sessionMs: integer(environment.SESSION_HOURS, 8, 1, 168, 'SESSION_HOURS') * 3600000,
    secureCookie: cookieValue === 'true',
    trustProxy: parseTrustProxy(environment.TRUST_PROXY),
    production: environment.NODE_ENV === 'production',
    pageSize: 30
  };
}
