/**
 * Drizzle Kit 配置
 *
 * 依据：《数据库设计 V1.1》
 *   - Schema 位于 src/database/schema/（按文档模块拆分）
 *   - Migration 输出到 drizzle/
 *   - 方言 PostgreSQL，驱动 pg
 *
 * 环境变量来源：Node 原生 --env-file 或 shell 环境，见 package.json 脚本。
 * 本文件不引入 dotenv，保持依赖最小（Node >= 20.6 支持 --env-file）。
 */
import type { Config } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    '缺少 DATABASE_URL。请确认 .env 存在，并以 --env-file=.env 运行，' +
      '或在 shell 中导出该变量。参考 .env.example。'
  );
}

export default {
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  // 迁移记录表名，保持默认以免与文档描述产生歧义
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
  // 严格模式：生成迁移时对歧义操作给出提示而非静默选择
  strict: true,
  verbose: true,
} satisfies Config;
