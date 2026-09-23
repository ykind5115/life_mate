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
import { eq } from 'drizzle-orm';

import { db } from '../client.js';
import { users, type User } from '../schema/users.js';
import type { ExecutorOption } from './types.js';

/** 单用户模式下唯一用户的名称。固定值，用于幂等创建 */
export const DEFAULT_USER_NAME = 'me';

/**
 * 取当前用户；不存在则创建。
 *
 * V1.0 单用户约定：**用户表里只应有一条 name = 'me' 的记录**。
 * 按 name 查而不是「取 created_at 最早的一条」——
 * 后者在库里有历史脏数据（或测试建过别的用户）时会静默指向错误的人，
 * 而且「哪条最早」还依赖时钟。name 是固定常量，确定性更强。
 *
 * ⚠️ 并发说明：两个请求同时进来时可能都走到 insert，生成两条记录。
 *    单用户本地部署不会发生，且当前没有唯一约束拦它。
 *    要彻底堵住需在 name 上加唯一索引 —— 那是表结构变更，
 *    按 AGENTS.md §4.1 应先改 docs/03 再改 schema，因此这里不动。
 */
export async function getOrCreateDefaultUser(
  options: ExecutorOption = {}
): Promise<User> {
  const exec = options.executor ?? db;

  const existing = await exec
    .select()
    .from(users)
    .where(eq(users.name, DEFAULT_USER_NAME))
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

/**
 * 幂等地确保默认用户存在，返回它。
 *
 * 供服务启动时调用：把「用户记录什么时候出现」变成**确定的一步**，
 * 而不是「第一次有人聊天时隐式出现」。
 * 好处是运维与测试都有明确的前置条件可依赖。
 *
 * 与 getOrCreateDefaultUser 的关系：本函数是它在启动期的语义化别名，
 * 存在的目的是让调用点读到「我在做初始化」而不是「我在查用户」。
 */
export async function ensureDefaultUser(options: ExecutorOption = {}): Promise<User> {
  return getOrCreateDefaultUser(options);
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
