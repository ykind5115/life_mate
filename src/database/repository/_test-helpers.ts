/**
 * 测试辅助：在可回滚的事务中执行一组操作
 *
 * 依据：Node 的测试运行器默认串行执行测试文件内的用例，
 *       因此可以用「每个用例一个顶层事务、结束即回滚」保证互不干扰。
 *
 * 为什么可行：已验证（见提交记录）Drizzle 的事务对象支持嵌套 ——
 *   在已有事务中调用 tx.transaction() 会生成 SAVEPOINT，
 *   内层回滚不会中断外层。仓库方法因此可以接受外部执行器。
 */
import { sql } from 'drizzle-orm';

import { db } from '../client.js';
import { users, type User } from '../schema/users.js';
import { assertIsolatedUser, assertTestDatabase } from '../../shared/test-guard.js';
import { ensureDefaultUser, resolveUserName } from './user-store.js';

/** 事务内外通用的执行器类型 */
export type TestExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 仅用于触发回滚的信号，不应被当作失败 */
class RollbackSignal extends Error {
  constructor() {
    super('intentional rollback');
    this.name = 'RollbackSignal';
  }
}

/**
 * 在一个最终必定回滚的事务里跑 fn。
 *
 * fn 收到的 ctx.exec 可直接传给仓库方法的 { executor } 选项，
 * 从而使所有写入都在本事务内，结束时一并撤销。
 * ctx.userId 是本次用例专属的测试用户，避免用例间通过 userId 互相干扰。
 */
export async function withTestContext(
  fn: (ctx: { exec: TestExecutor; userId: string }) => Promise<void>
): Promise<void> {
  /**
   * ⚠️ 本函数会写库（虽然会回滚，但回滚本身也依赖连对了库 ——
   *    若连的是开发库，任何一次意外提交都会落进真实数据）。
   *    守卫在此，防止测试连错库。
   */
  assertTestDatabase('_test-helpers.ts / withTestContext');

  try {
    await db.transaction(async (tx) => {
      const userId = await seedUser(tx);
      await fn({ exec: tx, userId });
      // 无论 fn 是否抛错，都回滚
      throw new RollbackSignal();
    });
  } catch (err) {
    if (err instanceof RollbackSignal) return;
    throw err;
  }
}

/** 建一个测试用户，返回其 id。用户随事务回滚一起消失 */
export async function seedUser(exec: TestExecutor, name = 'repo-test'): Promise<string> {
  const rows = await exec
    .insert(users)
    .values({ name })
    .returning({ id: users.id });

  const id = rows[0]?.id;
  if (!id) throw new Error('创建测试用户失败');
  return id;
}

/**
 * 取本次测试要用的用户，**并保证它不是真实用户**。
 *
 * 🔴 【为什么夹具必须用这个，而不是直接调 ensureDefaultUser】
 *   多个 HTTP 测试夹具的写法是「取当前用户 → 清空它名下的数据」：
 *
 *     const user = await ensureDefaultUser();
 *     await db.delete(memories).where(eq(memories.userId, user.id));
 *
 *   也就是说它们删的是「当前用户」的全部数据。而当前用户默认是 **'me'** ——
 *   那是用户从 2026-09-24 起真实使用的账号，且他明确要求
 *   「对话记录必须保留」（对话不可再生：记忆/事件/摘要都能从它重新生成，
 *   它本身不能）。
 *
 *   因此这里在返回之前先断言用户名不是 'me'。
 *   隔离靠 .env.test 里的 LIFEMATE_USER_NAME=test-agent 落地，
 *   守卫只负责「万一没生效就报错而不是删数据」。
 *
 * @param context 调用点描述，出现在错误信息里便于定位
 */
export async function resolveTestUser(context: string): Promise<User> {
  const name = resolveUserName();
  assertIsolatedUser(name, context);
  return ensureDefaultUser();
}

/** 仓库方法的执行器选项快捷构造 */
export function opts(exec: TestExecutor): { executor: never } {
  return { executor: exec as never };
}

/**
 * 把错误（含 cause 链）拼成一段文本，便于用正则断言。
 *
 * 为什么需要：Drizzle 会把数据库返回的错误包装成
 *   Error: Failed query: insert into ...
 *     [cause]: error: duplicate key value violates unique constraint "..."
 * 直接断言外层 message 会匹配不到约束名等关键信息，
 * 于是「预期报错」的测试会假失败（错误确实抛了，只是断言方式不对）。
 */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;

  while (cur && depth < 5) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else if (typeof cur === 'object') {
      // pg 的 DatabaseError 上有 constraint / detail 等字段
      const o = cur as Record<string, unknown>;
      if (typeof o['message'] === 'string') parts.push(o['message']);
      if (typeof o['constraint'] === 'string') parts.push(`constraint=${o['constraint']}`);
      if (typeof o['detail'] === 'string') parts.push(`detail=${o['detail']}`);
      cur = o['cause'];
    } else {
      if (cur !== undefined && cur !== null) parts.push(String(cur));
      break;
    }
    depth++;
  }

  return parts.join(' | ');
}

/**
 * 断言某次调用因数据库约束而失败，并检查约束名出现在错误链的任意一层。
 *
 * @param constraintName 期望出现在错误信息里的约束名（如 uq_memories_current_slot）
 */
export async function assertRejectsWithConstraint(
  fn: () => Promise<unknown>,
  constraintName: string,
  hint: string
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const text = errorText(err);
    if (!text.includes(constraintName)) {
      throw new Error(
        `${hint}\n` +
          `预期错误信息中出现约束 ${constraintName}，实际错误链为：\n  ${text}`
      );
    }
    return;
  }

  throw new Error(`${hint}\n但调用并未抛错 —— 约束可能没有生效`);
}

/** 确认某张表里没有残留测试数据（用于验证回滚确实生效） */
export async function countUsersByName(name: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.name} = ${name}`);

  return rows[0]?.n ?? 0;
}
