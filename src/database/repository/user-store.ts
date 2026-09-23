/**
 * 用户查询与供给
 *
 * 【设计缺口，已按最小方案实现，需产品确认】
 *   docs/03 §8 只说「单用户系统仍保留 users 表，避免未来重构整个数据模型」，
 *   但**没有规定这条用户记录由谁创建、何时创建**：
 *     ① 初始化脚本 seed 一条固定用户 → 需要额外一步部署动作，忘记就 500
 *     ② 首次使用时自动创建 → 零配置，但「用户」会隐式出现
 *
 *   这里选 ②，理由是单用户项目的部署成本比理论纯洁性重要，
 *   且 users 表本就不是业务实体。取名 DEFAULT_USER_NAME 是固定常量，
 *   因此并发重复创建会发生（见 getOrCreateDefaultUser 的说明）。
 *
 *   ⚠️ 若后续要做多用户，这两处都需要改：本函数与调用点。
 */
import { asc, eq } from 'drizzle-orm';

import { db } from '../client.js';
import { users, type User } from '../schema/users.js';
import type { ExecutorOption } from './types.js';

/** 单用户模式下唯一用户的名称。固定值，用于幂等创建 */
export const DEFAULT_USER_NAME = 'me';

/**
 * 取当前用户；不存在则创建。
 *
 * V1.0 单用户约定：**用户表里最多一条记录**。
 * 因此实现是「取第一条」而不是「按 id 取」—— 没有 id 可传。
 *
 * ⚠️ 并发说明：两个请求同时进来时可能都走到 insert，生成两条用户记录。
 *    单用户本地部署不会发生，且没有唯一约束拦它（name 不是唯一键）。
 *    要彻底堵住需要在 name 上加唯一索引 —— 那是表结构变更，
 *    按 AGENTS.md §4.1 应先改 docs/03 再改 schema，因此这里不动。
 */
export async function getOrCreateDefaultUser(
  options: ExecutorOption = {}
): Promise<User> {
  const exec = options.executor ?? db;

  const existing = await exec
    .select()
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (existing[0]) return existing[0];

  const created = await exec
    .insert(users)
    .values({ name: DEFAULT_USER_NAME })
    .returning();

  const user = created[0];
  if (!user) throw new Error('创建默认用户后未返回记录');
  return user;
}

/** 按 id 取用户。找不到返回 undefined */
export async function findUserById(
  id: string,
  options: ExecutorOption = {}
): Promise<User | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}
