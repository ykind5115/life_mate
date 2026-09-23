/**
 * Conversation 读查询
 *
 * 目前只服务抽取流水线：按序号范围读取消息。
 * 完整的会话管理（列表、摘要、分页）留到 API 层需要时再补。
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { messages, type Message } from '../schema/messages.js';
import type { ExecutorOption } from './types.js';

/**
 * 读取某会话指定序号区间内的消息（闭区间）。
 *
 * 按 sequence 升序返回 —— 抽取器需要按对话顺序理解上下文，
 * 顺序错了会把因果关系读反（例如把「本来想学 A」和「后来改学 B」颠倒）。
 *
 * @param from 起始序号（含）
 * @param to   结束序号（含）
 */
export async function findMessagesInRange(
  params: { conversationId: string; from: number; to: number },
  options: ExecutorOption = {}
): Promise<Message[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, params.conversationId),
        gte(messages.sequence, params.from),
        lte(messages.sequence, params.to)
      )
    )
    .orderBy(asc(messages.sequence));
}

/** 某会话的最大消息序号。没有消息时返回 0 */
export async function maxMessageSequence(
  conversationId: string,
  options: ExecutorOption = {}
): Promise<number> {
  const exec = options.executor ?? db;

  // ⚠️ ::int 必须显式转型：bigint 经 pg 驱动返回字符串（见 nextStartSequence 的说明）
  const rows = await exec
    .select({ maxSeq: sql<number | null>`MAX(${messages.sequence})::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  return rows[0]?.maxSeq ?? 0;
}
