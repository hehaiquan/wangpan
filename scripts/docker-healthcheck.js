/** 检查容器内登录页面是否正常响应，失败时返回非零退出码。 */
async function checkHealth() {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/login`, {
      signal: AbortSignal.timeout(4000),
      redirect: 'manual'
    });
    await response.body?.cancel();
    process.exitCode = response.status === 200 ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}

await checkHealth();
