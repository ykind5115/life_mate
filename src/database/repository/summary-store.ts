/**
 * conversation_summaries 读写（docs/03 §12）
 *
 * 【存在的目的】（§12.1）
 *   避免把整个 Conversation 永久塞进 LLM Context。
 *   长对话时：旧消息 → 摘要 → 只保留摘要 + 最近原文。
 *
 * 【物理删除】（C29）
 *   没有 deleted_at —— 摘要由消息派生，消息没了摘要没有保留意义。
 *   删除会话时随 §24.3 步骤⑤ 一起物理删除。
 */
import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';

import { db } from '../client.js';
import {
  conversationSummaries,
  type ConversationSummary,
} from '../schema/conversation-summaries.js';
import type { ExecutorOption } from './types.js';

/**
 * 取会话里**有效**的摘要，按覆盖区间正序。
 *
 * ⚠️ 必须按 sequence_from 正序：§12.4 要求摘要位于最近消息之前，
 *    否则模型会误判时间顺序（把后来的事当成先发生的）。
 *
 * 只取 status='active' —— 'stale' 表示它覆盖的消息已被删除，
 * 内容可能不准确，应等重新生成（§12.3 的失效规则）。
 */
export async function listActiveSummaries(
  conversationId: string,
  options: ExecutorOption = {}
): Promise<ConversationSummary[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(conversationSummaries)
    .where(
      and(
        eq(conversationSummaries.conversationId, conversationId),
        eq(conversationSummaries.status, 'active')
      )
    )
    .orderBy(asc(conversationSummaries.sequenceFrom));
}

/**
 * 取已摘要到的最大序号。
 *
 * 返回 0 表示还没有任何摘要 —— 未摘要区间从 1 开始。
 * 与 extraction_runs 的 nextStartSequence 是同一套「进度由 MAX 推进」的思路，
 * 但这里更简单：摘要不重试，也没有失败态需要覆盖。
 */
export async function maxSummarizedSequence(
  conversationId: string,
  options: ExecutorOption = {}
): Promise<number> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({ maxSeq: conversationSummaries.sequenceTo })
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .orderBy(desc(conversationSummaries.sequenceTo))
    .limit(1);

  // bigint 列用 mode:'number'，驱动返回 number；这里不做转型
  return rows[0]?.maxSeq ?? 0;
}

/**
 * 写入一段摘要。
 *
 * 幂等：uq_summaries_range 唯一索引会拦住同一区间的重复写入。
 * 调用方应先查 maxSummarizedSequence 决定区间，
 * **但不该依赖它来保证并发安全** —— 唯一索引才是最终防线。
 */
export async function createSummary(
  input: {
    conversationId: string;
    summary: string;
    sequenceFrom: number;
    sequenceTo: number;
    summarizerVersion: string;
  },
  options: ExecutorOption = {}
): Promise<ConversationSummary> {
  const exec = options.executor ?? db;

  const rows = await exec
    .insert(conversationSummaries)
    .values({
      conversationId: input.conversationId,
      summary: input.summary,
      sequenceFrom: input.sequenceFrom,
      sequenceTo: input.sequenceTo,
      summarizerVersion: input.summarizerVersion,
      status: 'active',
    })
    .returning();

  const summary = rows[0];
  if (!summary) throw new Error('插入摘要后未返回记录');
  return summary;
}

/**
 * 把覆盖了被删消息的摘要标记为 stale（§12.3 的失效规则）。
 *
 * 触发点：删除消息时。§24.3 的会话删除流程是**直接物理删除**摘要
 * （消息全没了，摘要没有保留意义），
 * 而本函数服务的是**部分消息被删除**的场景。
 *
 * ⚠️ V1.0 没有「单条消息删除」的入口（删除都是整会话），
 *    因此本函数目前没有调用点。保留它的理由：
 *    它是 §12.3 明确规定的失效规则，且实现成本极低；
 *    等单条删除做出来时不必再回头补。
 *    若一直没有调用点，应在实现单条删除时评估是否真的需要。
 */
export async function markSummariesStale(
  params: { conversationId: string; deletedSequences: number[] },
  options: ExecutorOption = {}
): Promise<number> {
  const exec = options.executor ?? db;
  if (params.deletedSequences.length === 0) return 0;

  const min = Math.min(...params.deletedSequences);
  const max = Math.max(...params.deletedSequences);

  // 区间有重叠就置 stale —— 摘要覆盖了被删消息，内容不再准确
  const rows = await exec
    .update(conversationSummaries)
    .set({ status: 'stale' })
    .where(
      and(
        eq(conversationSummaries.conversationId, params.conversationId),
        lte(conversationSummaries.sequenceFrom, max),
        gt(conversationSummaries.sequenceTo, min),
        eq(conversationSummaries.status, 'active')
      )
    )
    .returning({ id: conversationSummaries.id });

  return rows.length;
}
