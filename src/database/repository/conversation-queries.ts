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

/**
 * 某会话的**第一条用户消息**。
 *
 * 用途：会话标题的占位文案与「是否还需要生成正式标题」的判据
 * （docs/12 §方案 2）。占位标题是「首条用户消息截断」，
 * 因此凡是需要重算它的地方都得拿到这条消息。
 *
 * ⚠️ 为什么必须从库里取，而不是拿当前标题反推：
 *    当前标题可能是**正式标题**（已生成）或**用户改过的名字**，
 *    对它再截断一次只会得到一个毫无意义的字符串，
 *    然后拿它去和当前标题比较必然相等 → 生成器会误判「还需要生成」→
 *    每次对话都重新生成标题并覆盖用户改的名字。
 *
 * 走 idx_messages_conversation_sequence 索引，代价可忽略。
 * 返回 undefined 表示该会话还没有用户消息（正常路径下不会出现）。
 */
export async function findFirstUserMessage(
  conversationId: string,
  options: ExecutorOption = {}
): Promise<Message | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
    .orderBy(asc(messages.sequence))
    .limit(1);

  return rows[0];
}
