/**
 * Migration 执行器
 *
 * 依据：AGENTS.md §4.1 —— 每次 Migration 都要在真实容器里执行过一次，
 *       并验证表结构与约束。
 *
 * 运行：pnpm db:migrate   （已内置 --env-file=.env）
 *
 * 注意：已应用的 migration 永不修改；需要变更就追加新的。
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { closePool, db } from './client.js';

async function main(): Promise<void> {
  console.log('开始执行 migration...');
  const startedAt = Date.now();

  await migrate(db, { migrationsFolder: './drizzle' });

  console.log(`migration 完成，耗时 ${Date.now() - startedAt} ms`);
}

main()
  .catch((err: unknown) => {
    console.error('migration 失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
