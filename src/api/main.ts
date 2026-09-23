/**
 * HTTP 服务入口
 *
 * 运行：pnpm dev        （开发，自动重载）
 *       pnpm start      （生产）
 *
 * 【为什么单独一个文件】
 *   server.ts 只负责「组装」，监听端口与进程生命周期在这里。
 *   这样测试可以 buildServer() 后用 inject() 直接打请求，
 *   不需要真的占一个端口。
 */
import { buildServer } from './server.js';
import { env } from '../shared/env.js';
import { closePool } from '../database/client.js';

async function main(): Promise<void> {
  const app = await buildServer();

  /**
   * 优雅退出。
   *
   * ⚠️ 顺序不能颠倒：先 app.close() 停止接收新请求并等在途请求结束，
   *    再关连接池。反过来会让在途请求拿到「连接已关闭」的错误。
   */
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，开始优雅退出`);
    try {
      await app.close();
      await closePool();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '退出过程中出错');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: env.HOST, port: env.PORT });

  /**
   * 启动横幅里**不回显任何配置值**（模型名、连接串、密钥都可能敏感）。
   * 只说明监听地址 —— 这句话本身对排查「端口被占」是必需的。
   */
  app.log.info(
    `LifeMate 已启动：http://${env.HOST}:${env.PORT}（环境 ${env.NODE_ENV}）`
  );

  if (env.HOST !== '127.0.0.1' && env.HOST !== 'localhost') {
    /**
     * 本项目保存私密生活数据（docs/03 §29），绑非回环地址意味着
     * 局域网内任何人都能读写整个记忆库。必须显式告警。
     */
    app.log.warn(
      `⚠️ HOST=${env.HOST} 不是回环地址。记忆库将对同网段可访问，请确认这是有意为之。`
    );
  }
}

main().catch((err: unknown) => {
  console.error('服务启动失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
