import { AppError } from './errors.js';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

/** 以北京时间显示数据库中的 UTC 时间。 */
export function formatTime(value) {
  if (!value) return '—';
  return dateFormatter.format(new Date(value)).replaceAll('/', '-');
}

/** 把字节数格式化为易读文件大小。 */
export function formatSize(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1024) return value + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return size.toFixed(size >= 10 ? 1 : 2) + ' ' + units[index];
}

/** 生成经过编码的页面链接，保留中文、空格和特殊字符文件名。 */
export function linkTo(route, parameters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== '' && value !== null && value !== undefined) query.set(key, String(value));
  }
  return route + (query.size ? '?' + query.toString() : '');
}

/** 校验分页参数，防止负偏移和无限制分页查询。 */
export function pageNumber(value) {
  if (value === undefined || value === '') return 1;
  if (typeof value !== 'string' || !/^[1-9]\d{0,6}$/.test(value)) throw new AppError(400, '页码格式不正确');
  return Number(value);
}

/** 校验查询文本，拒绝数组和超长字符串。 */
export function queryText(value, limit = 128) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit) throw new AppError(400, '查询条件格式不正确');
  return value.trim();
}

/** 为日志筛选构造精确的北京时间日期边界。 */
function dateBoundary(value, isEnd) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(400, '日期格式不正确');
  const date = new Date(value + 'T00:00:00+08:00');
  if (!Number.isFinite(date.getTime()) || dateFormatter.format(date).slice(0, 10).replaceAll('/', '-') !== value) {
    throw new AppError(400, '日期格式不正确');
  }
  return new Date(date.getTime() + (isEnd ? 86400000 : 0)).toISOString();
}

/** 按白名单条件查询登录或下载记录，所有用户输入均作为 SQL 参数。 */
export function queryLogs(db, type, query, pageSize) {
  const isLogin = type === 'login';
  const table = isLogin ? 'login_logs' : 'download_logs';
  const time = isLogin ? 'created_at' : 'started_at';
  const filters = {
    username: queryText(query.username, 64),
    ip: queryText(query.ip, 64),
    result: queryText(query.result, 20),
    from: queryText(query.from, 10),
    to: queryText(query.to, 10)
  };
  const allowed = isLogin ? ['success', 'failed', 'limited'] : ['started', 'completed', 'failed', 'interrupted'];
  if (filters.result && !allowed.includes(filters.result)) throw new AppError(400, '操作结果筛选无效');
  const clauses = [];
  const values = [];
  for (const field of ['username', 'ip', 'result']) {
    if (filters[field]) { clauses.push(field + ' = ?'); values.push(filters[field]); }
  }
  const start = dateBoundary(filters.from, false);
  const end = dateBoundary(filters.to, true);
  if (start && end && start >= end) throw new AppError(400, '开始日期不能晚于结束日期');
  if (start) { clauses.push(time + ' >= ?'); values.push(start); }
  if (end) { clauses.push(time + ' < ?'); values.push(end); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS total FROM ' + table + where).get(...values).total;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageNumber(query.page), pages);
  const rows = db.prepare('SELECT * FROM ' + table + where + ' ORDER BY ' + time + ' DESC, id DESC LIMIT ? OFFSET ?')
    .all(...values, pageSize, (page - 1) * pageSize);
  return { rows, filters, total, pages, page };
}

export const resultLabels = {
  success: '登录成功', failed: '失败', limited: '登录受限',
  started: '传输中', completed: '服务端发送完成', interrupted: '中断'
};
