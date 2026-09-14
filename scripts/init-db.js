import { loadEnvironment, loadConfig } from '../src/config.js';
import { openDatabase, initializeAccounts } from '../src/database.js';

/** 创建数据库和两个内置账号，已有账号不会被恢复为默认值。 */
async function initialize() {
  loadEnvironment();
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  try {
    const created = await initializeAccounts(db);
    console.log(created ? '已初始化 admin（管理员）和 user（普通用户），初始密码见 docs/使用说明.md。' : '已有账号，未修改任何账号、密码或状态。');
  } finally {
    db.close();
  }
}

initialize().catch(error => {
  console.error('初始化失败：', error.message);
  process.exitCode = 1;
});
