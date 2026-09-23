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

/**
 * 默认用户名称。固定值，用于幂等创建。
 *
 * ⚠️ 这是**真实数据所属的用户**。任何会删除数据的脚本/测试
 *    都必须避开它 —— 见 resolveUserName 的说明。
 */
export const DEFAULT_USER_NAME = 'me';

/**
 * 当前进程使用哪个用户。
 *
 * 【为什么需要它 —— 一次不可逆风险的防范】
 *   2026-09-24 起用户开始真实使用，并明确要求：
 *   「我的测试数据都保留，特别是对话记录」。
 *   对话记录是**不可再生**的资产 —— 记忆、事件、摘要都能从它重新生成，
 *   但它本身被删就没了。
 *
 *   而开发期的测试与脚本习惯性地假设「库里只有默认用户」，
 *   并且会**清空该用户名下的数据**。一旦在用户真实使用后跑一次，
 *   数据就没了，且无法恢复。
 *
 *   因此引入本开关：测试与脚本可以指向一个独立用户，
 *   从而在**数据库层面**与真实数据隔离 —— 不依赖「记得别删」这种自觉。
 *
 * 用法：
 *   生产：不设 LIFEMATE_USER_NAME（用 'me'）
 *   测试：LIFEMATE_USER_NAME=test-agent pnpm start
 *
 * ⚠️ 刻意**不**在 .env.example 里默认开启：它不该是日常配置项，
 *    只是隔离手段。默认值必须指向真实用户，否则用户会以为数据丢了。
 */
export function resolveUserName(): string {
  const raw = process.env['LIFEMATE_USER_NAME'];
  if (typeof raw !== 'string') return DEFAULT_USER_NAME;
  const trimmed = raw.trim();
  // 空值视为未设置 —— 避免 LIFEMATE_USER_NAME= 这种写法意外指向空名用户
  return trimmed.length > 0 ? trimmed : DEFAULT_USER_NAME;
}

/** 当前进程是否运行在隔离的测试用户上。用于日志与脚本的安全判断 */
export function isIsolatedUser(): boolean {
  return resolveUserName() !== DEFAULT_USER_NAME;
}

/**
 * 取当前用户；不存在则创建。
 *
 * V1.0 单用户约定：**用户表里只应有一条 name = 'me' 的记录**。
 * 按 name 查而不是「取 created_at 最早的一条」——
 * 后者在库里有历史脏数据（或测试建过别的用户）时会静默指向错误的人，
 * 而且「哪条最早」还依赖时钟。name 是固定常量，确定性更强。
 *
 * ⚠️ 查询用的是 resolveUserName() 而不是常量 'me' ——
 *    测试可通过 LIFEMATE_USER_NAME 指向独立用户，见上面的说明。
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
  const name = resolveUserName();

  const existing = await exec
    .select()
    .from(users)
    .where(eq(users.name, name))
    .limit(1);

  if (existing[0]) return existing[0];

  const created = await exec
    .insert(users)
    .values({ name })
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
