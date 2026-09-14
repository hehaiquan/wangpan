import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';
import { projectRoot } from '../src/config.js';

/** 递归收集源码和模板，避免检查依赖或运行数据。 */
function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(filename) : [filename];
  });
}

/** 检查 JavaScript 语法和 EJS 模板编译，不执行前端构建。 */
function check() {
  const files = ['src', 'scripts', 'public', 'test', 'views'].flatMap(folder => collect(path.join(projectRoot, folder)));
  let count = 0;
  for (const filename of files) {
    if (filename.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(1);
      count += 1;
    } else if (filename.endsWith('.ejs')) {
      ejs.compile(fs.readFileSync(filename, 'utf8'), { filename });
      count += 1;
    }
  }
  console.log('源码与模板检查通过，共 ' + count + ' 个文件；未构建前端。');
}

check();
