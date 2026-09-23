/**
 * 测试数据库守卫
 *
 * 【为什么需要这个文件 —— 一次真实的事故】
 *   2026-09-23：memory-routes 的测试夹具为了让列表断言稳定，
 *   在用例开始时删除了「默认用户」名下的全部记忆，结束时再删一次。
 *   而测试连的是**开发库**（DATABASE_URL 指向 lifemate），
 *   结果是每跑一次 `pnpm test`，就把开发库里真实抽取出来的记忆清空一次。
 *   发现时库里只剩 2 条（原本 14 条），embeddings 全没了，
 *   另有 324 个测试留下的会话堆积。
 *
 *   损失可控（那些是本机测试数据），但这类缺陷的性质很严重：
 *   测试**绝不应该**有能力碰真实数据。靠"记得别那么写"是防不住的，
 *   必须在入口处挡住。
 *
 * 【两道防线】
 *   ① 本文件的 assertTestDatabase()：库名里必须含 test，
 *      否则直接抛错终止。**默认拒绝**，而不是默认允许。
 *   ② package.json 的 test 脚本显式 --env-file=.env.test：
 *      测试根本不读开发配置，即使有人忘了①也碰不到开发库。
 *
 * 调用点：所有会**写**数据的测试夹具（HTTP 集成测试、评测脚本）。
 * 只读的单元测试不需要（它们不连库）。
 */
import { env } from '../shared/env.js';

/**
 * 从连接串里取出数据库名。
 *
 * 不用 new URL() 再取 pathname 的简单写法：密码里若有未编码的
 * 特殊字符会让 URL 解析抛错，而我们只是想知道库名，
 * 不该因为密码格式而失败。这里退化为字符串处理。
 */
export function databaseNameOf(connectionString: string): string {
  const withoutQuery = connectionString.split('?')[0] ?? connectionString;
  const lastSlash = withoutQuery.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return withoutQuery.slice(lastSlash + 1);
}

/** 库名是否看起来是测试库 */
export function isTestDatabaseName(name: string): boolean {
  return /test/i.test(name);
}

/** 当前连接的库名 */
export function currentDatabaseName(): string {
  return databaseNameOf(env.DATABASE_URL);
}

/**
 * 断言当前连的是测试库。不是就抛错。
 *
 * @param context 调用方描述，出现在错误信息里便于定位是谁在写数据
 */
export function assertTestDatabase(context: string): void {
  const name = currentDatabaseName();

  if (isTestDatabaseName(name)) return;

  throw new Error(
    `拒绝在非测试数据库上执行会写数据的测试操作。\n` +
      `  调用点：${context}\n` +
      `  当前库：${name}\n` +
      `  期望库名包含 "test"（例如 lifemate_test）。\n\n` +
      `这是硬性保护：测试夹具会删除数据，跑在开发库上会毁掉真实记忆\n` +
      `（2026-09-23 实际发生过：开发库里 14 条记忆被测试清空）。\n\n` +
      `正确做法：\n` +
      `  ① 确认 .env.test 里 DATABASE_URL 指向 *_test 库\n` +
      `  ② 用 pnpm test 运行（脚本已指定 --env-file=.env.test）\n` +
      `  ③ 测试库不存在时先创建：见 docs/05-environment-setup.md`
  );
}
