import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isInside } from './config.js';
import { AppError } from './errors.js';

/** 检查请求路径，只接受根目录下的相对路径，不重复解码 URL 参数。 */
export function normalizeRelativePath(value = '') {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new AppError(400, '文件路径格式不正确');
  }
  if (value.split('/').includes('..')) throw new AppError(403, '不能访问共享目录以外的文件');
  const normalized = path.posix.normalize(value);
  return normalized === '.' ? '' : normalized.replace(/\/$/, '');
}

/** 将系统文件错误转换为可理解且不暴露绝对路径的提示。 */
export function fileError(error) {
  if (error instanceof AppError) return error;
  if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return new AppError(404, '文件或目录不存在，请刷新后重试');
  if (['EACCES', 'EPERM'].includes(error.code)) return new AppError(403, '没有读取此文件或目录的权限');
  return new AppError(500, '读取文件失败，请稍后重试');
}

/** 检查真实路径边界，允许根目录内部链接，但禁止链接到根目录之外。 */
export async function resolveFile(root, input, kind) {
  try {
    const relative = normalizeRelativePath(input);
    const absolute = path.resolve(root, relative);
    if (!isInside(root, absolute)) throw new AppError(403, '不能访问共享目录以外的文件');
    const real = await fs.realpath(absolute);
    if (!isInside(root, real)) throw new AppError(403, '不能访问指向共享目录之外的链接');
    const stat = await fs.stat(real);
    if (kind === 'directory' && !stat.isDirectory()) throw new AppError(400, '此路径不是文件夹');
    if (kind === 'file' && !stat.isFile()) throw new AppError(400, '只能下载普通文件');
    return { relative, real, stat };
  } catch (error) {
    throw fileError(error);
  }
}

/** 读取当前目录并限制元数据查询并发，避免大目录耗尽文件句柄。 */
export async function listDirectory(root, input, query = '', requestedPage = 1, pageSize = 30) {
  const directory = await resolveFile(root, input, 'directory');
  let entries;
  try {
    entries = await fs.readdir(directory.real, { withFileTypes: true });
  } catch (error) {
    throw fileError(error);
  }
  const candidates = entries.filter(entry => !['.gitkeep', '.DS_Store'].includes(entry.name) && !/[\x00-\x1f\x7f\\]/.test(entry.name) && entry.name.toLocaleLowerCase('zh-CN').includes(query.toLocaleLowerCase('zh-CN')));
  const visible = [];
  for (let offset = 0; offset < candidates.length; offset += 32) {
    const batch = await Promise.all(candidates.slice(offset, offset + 32).map(async entry => {
      const relative = [directory.relative, entry.name].filter(Boolean).join('/');
      try {
        const item = await resolveFile(root, relative);
        if (!item.stat.isFile() && !item.stat.isDirectory()) return null;
        return { name: entry.name, relative, isDirectory: item.stat.isDirectory(), size: item.stat.size, modified: item.stat.mtime.toISOString() };
      } catch (error) {
        if (error.status === 403 || error.status === 404) return null;
        throw error;
      }
    }));
    visible.push(...batch.filter(Boolean));
  }
  visible.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const total = visible.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pages);
  return {
    relative: directory.relative,
    parent: path.posix.dirname(directory.relative) === '.' ? '' : path.posix.dirname(directory.relative),
    items: visible.slice((page - 1) * pageSize, page * pageSize),
    total, page, pages,
    folderCount: visible.filter(item => item.isDirectory).length,
    fileCount: visible.filter(item => !item.isDirectory).length,
    fileBytes: visible.filter(item => !item.isDirectory).reduce((sum, item) => sum + item.size, 0),
    breadcrumbs: directory.relative.split('/').filter(Boolean).map((name, index, parts) => ({ name, relative: parts.slice(0, index + 1).join('/') }))
  };
}

/** 打开并固定下载句柄，检查打开前后文件身份，减少路径替换带来的竞态。 */
export async function openDownload(root, input) {
  const target = await resolveFile(root, input, 'file');
  let handle;
  try {
    handle = await fs.open(target.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    const current = await resolveFile(root, input, 'file');
    if (!stat.isFile() || stat.dev !== current.stat.dev || stat.ino !== current.stat.ino) {
      throw new AppError(409, '文件已发生变化，请刷新后重新下载');
    }
    return { ...current, stat, handle };
  } catch (error) {
    if (handle) await handle.close();
    throw fileError(error);
  }
}
