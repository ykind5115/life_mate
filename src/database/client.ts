/**
 * 数据库客户端
 *
 * 依据：《数据库设计 V1.1》
 *   - ORM: Drizzle ORM，驱动 pg（§3.1、§33 基线）
 *   - 分层铁律：只有 Repository 层碰数据库（AGENTS.md §3）
 *     本文件只导出连接与 db 实例，不承载任何业务查询
 *
 * 注意：本项目是单用户、低并发场景，
 *       因此使用单个连接池并保持默认池大小，不做特殊调优。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../shared/env.js';
import * as schema from './schema/index.js';

/**
 * 连接池。进程级单例。
 *
 * 时区说明：PostgreSQL 侧固定为 Asia/Shanghai（见 docker-compose.yml），
 * TIMESTAMPTZ 内部以 UTC 存储，展示时按会话时区换算，因此这里不需要额外设置。
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // 单用户场景，池不需要大
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err: Error) => {
  // 空闲连接报错不应导致进程崩溃（架构 §39 错误处理）
  console.error('[db] 空闲连接异常：', err.message);
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

/** 优雅关闭，供进程退出钩子调用 */
export async function closePool(): Promise<void> {
  await pool.end();
}
