import { loadEnvironment, loadConfig } from './config.js';
import { createApp } from './app.js';

/** 启动单实例 HTTP 服务，并在进程停止时收尾下载和数据库连接。 */
async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('请使用 Node.js 24，可先运行 nvm use');
  loadEnvironment();
  const config = loadConfig();
  const application = await createApp(config);
  const server = application.app.listen(config.port, config.host, () => {
    console.log('网盘服务已启动：http://' + config.host + ':' + config.port);
  });
  let stopping = false;
  /** 停止接收请求，给传输留出收尾时间，随后释放数据库。 */
  function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log('网盘服务正在停止');
    const timer = setTimeout(() => server.closeAllConnections(), 20000);
    timer.unref();
    server.close(async () => {
      clearTimeout(timer);
      await application.close();
    });
  }
  server.on('error', async error => {
    console.error('服务启动失败：', error.code || 'SERVER_ERROR');
    await application.close();
    process.exitCode = 1;
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error('启动失败：', error.message);
  process.exitCode = 1;
});
