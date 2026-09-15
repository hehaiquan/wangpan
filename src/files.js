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

/** 浏览当前目录；有关键词时遍历子目录，跳过目录链接以避免循环和重复搜索。 */
export async function listDirectory(root, input, query = '', requestedPage = 1, pageSize = 30) {
  const directory = await resolveFile(root, input, 'directory');
  const keyword = query.toLocaleLowerCase('zh-CN');
  const pending = [directory.relative];
  const visited = new Set();
  const visible = [];
  let skippedDirectories = 0;
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      const resolved = await resolveFile(root, current, 'directory');
      if (visited.has(resolved.real)) continue;
      visited.add(resolved.real);
      entries = await fs.readdir(resolved.real, { withFileTypes: true });
    } catch (error) {
      const failure = fileError(error);
      if (current !== directory.relative && [403, 404].includes(failure.status)) {
        skippedDirectories += 1;
        continue;
      }
      throw failure;
    }
    const candidates = entries.filter(entry => !['.gitkeep', '.DS_Store'].includes(entry.name) && !/[\x00-\x1f\x7f\\]/.test(entry.name));
    for (let offset = 0; offset < candidates.length; offset += 32) {
      const batch = await Promise.all(candidates.slice(offset, offset + 32).map(async entry => {
        const relative = [current, entry.name].filter(Boolean).join('/');
        try {
          const item = await resolveFile(root, relative);
          if (!item.stat.isFile() && !item.stat.isDirectory()) return null;
          if (keyword && entry.isDirectory()) pending.push(relative);
          if (!entry.name.toLocaleLowerCase('zh-CN').includes(keyword)) return null;
          return { name: entry.name, relative, isDirectory: item.stat.isDirectory(), size: item.stat.size, modified: item.stat.mtime.toISOString() };
        } catch (error) {
          if (error.status === 403 || error.status === 404) return null;
          throw error;
        }
      }));
      visible.push(...batch.filter(Boolean));
    }
  }
  visible.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.relative.localeCompare(b.relative, 'zh-CN', { numeric: true }));
  const total = visible.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pages);
  return {
    relative: directory.relative,
    parent: path.posix.dirname(directory.relative) === '.' ? '' : path.posix.dirname(directory.relative),
    items: visible.slice((page - 1) * pageSize, page * pageSize),
    total, page, pages, skippedDirectories,
    folderCount: visible.filter(item => item.isDirectory).length,
    fileCount: visible.filter(item => !item.isDirectory).length,
    fileBytes: visible.filter(item => !item.isDirectory).reduce((sum, item) => sum + item.size, 0),
    breadcrumbs: directory.relative.split('/').filter(Boolean).map((name, index, parts) => ({ name, relative: parts.slice(0, index + 1).join('/') }))
  };
}

/** 删除共享根下的文件或整个目录；拒绝通过目录链接删除，末级链接仅删除链接本身。 */
export async function deleteEntry(root, input) {
  try {
    const relative = normalizeRelativePath(input);
    if (!relative) throw new AppError(403, '不能删除共享根目录');
    const parts = relative.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink()) throw new AppError(403, '不能通过目录链接删除文件，请进入实际目录操作');
      if (!stat.isDirectory()) throw new AppError(404, '文件或目录不存在，请刷新后重试');
    }
    const realParent = await fs.realpath(parent);
    if (!isInside(root, realParent)) throw new AppError(403, '不能删除共享目录以外的文件');
    const target = path.join(realParent, parts.at(-1));
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) await fs.unlink(target);
    else if (stat.isDirectory()) await fs.rm(target, { recursive: true });
    else if (stat.isFile()) await fs.unlink(target);
    else throw new AppError(400, '只能删除普通文件、文件夹或链接');
    return relative;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.code === 'EROFS') throw new AppError(403, '共享目录为只读挂载，无法删除，请将共享目录改为可写后重试');
    if (['EACCES', 'EPERM'].includes(error.code)) throw new AppError(403, '没有删除权限，请检查服务进程对目录的写入权限；文件夹内容可能已部分删除，请刷新查看');
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw fileError(error);
    throw new AppError(500, '删除未完成，请刷新查看文件状态后重试');
  }
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
