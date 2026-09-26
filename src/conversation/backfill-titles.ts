/**
 * 会话标题回填
 *
 * 【用途】
 *   「自动标题」是在聊天响应之后触发的（docs/12 §方案 2）。
 *   因此**该功能上线之前的会话**（title 为 NULL）不会自动获得标题 ——
 *   它们只有在你下次发言时才会被补上。
 *   本脚本把这件事提前做掉：立即给无标题的会话生成标题。
 *
 * 运行：
 *   pnpm title:backfill                 # 所有无标题的存活会话
 *   pnpm title:backfill <id> [id...]    # 只处理指定的几个会话
 *
 * ⚠️ 会真实调用 LLM（每个会话一次，几百 token）。
 *
 * 【为什么不做成 HTTP 端点或让它跑在服务里】
 *   它是一次性的运维动作，不是业务能力。做成端点要额外定义权限与并发语义，
 *   而单用户系统里「手动跑一次」是更小的面。
 *
 * 【安全】
 *   · 只改 conversations.title，不碰 messages / memories / events
 *   · **不覆盖已有标题** —— 哪怕显式指定了 id。
 *     生成器按「当前标题 === 占位标题」判断是否需要生成，
 *     因此用户手动改过名的会话会被看作 already_titled 而跳过。
 *     这是刻意的：批量脚本最不该做的事就是悄悄覆盖用户输入。
 *   · `--env-file` 指向 .env（开发库）—— 这是**有意**的：
 *     要回填的正是真实会话。但要拒绝在 NODE_ENV=test 下运行，避免误配。
 */
import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { conversations } from '../database/schema/conversations.js';
import { findFirstUserMessage } from '../database/repository/conversation-queries.js';
import { env } from '../shared/env.js';
import { buildPlaceholderTitle, generateConversationTitle } from './conversation-title.js';

async function main(): Promise<void> {
  if (env.NODE_ENV === 'test') {
    throw new Error(
      '拒绝在 NODE_ENV=test 下运行：本脚本会真实调用 LLM 并写库，' +
        '测试环境的标题由测试夹具自己处理'
    );
  }

  const explicitIds = process.argv.slice(2).filter((a) => a.length > 0);

  /**
   * 候选会话：存活、无标题。
   *
   * title 为 NULL 或空串都算「没有标题」——
   * createConversation 允许两种（`title: input.title ?? null`）。
   */
  const noTitle = or(isNull(conversations.title), eq(conversations.title, ''))!;
  const alive = ne(conversations.status, 'deleted');

  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      explicitIds.length > 0
        ? and(inArray(conversations.id, explicitIds), noTitle, alive)
        : and(noTitle, alive)
    )
    .orderBy(asc(conversations.createdAt));

  if (rows.length === 0) {
    console.info('[title] 没有需要回填的会话');
    return;
  }

  console.info(`[title] 待处理 ${rows.length} 个会话`);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    /**
     * 占位标题必须从**首条用户消息**重算，与 ChatService 的判据一致。
     * 传错（比如传空串）会让生成器误判 already_titled 而直接跳过。
     */
    const firstUserMessage = await findFirstUserMessage(row.id);
    if (!firstUserMessage) {
      console.info(`  - ${row.id}：没有用户消息，跳过`);
      skipped += 1;
      continue;
    }

    const placeholder = buildPlaceholderTitle(firstUserMessage.content);

    try {
      const result = await generateConversationTitle({
        conversationId: row.id,
        placeholderTitle: placeholder,
      });

      if (result.generated) {
        // 只记 id 与状态，不把标题正文打进日志 ——
        // 标题是从对话内容生成的，同属用户私密信息（§29.1 的精神）
        console.info(`  ✓ ${row.id}：已生成标题（${result.title?.length ?? 0} 字）`);
        done += 1;
      } else {
        console.info(`  - ${row.id}：跳过（${result.skippedReason}）`);
        skipped += 1;
      }
    } catch (err) {
      // 单个会话失败不影响其余的 —— 这是批量运维与事务的区别
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : '未知错误';
      console.error(`  ✗ ${row.id}：失败 —— ${msg}`);
      failed += 1;
    }
  }

  console.info(`[title] 完成：生成 ${done}，跳过 ${skipped}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * 顶层捕获：脚本必须在任何失败下都能关掉连接池，
 * 否则进程会挂着不退（连接池有活动连接时 Node 不会自行退出）。
 */
try {
  await main();
} catch (err) {
  console.error('[title] 回填中止：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closePool();
}
