/**
 * 抽取产出的事件写入（含去重）
 *
 * 【为什么单独一个模块，而不写在 event-store（Repository）里】
 *   「同一天 + 同标题算重复」是一条**业务规则**，不是数据访问。
 *   仓库层的职责是「读写 events 表」，把判断规则放进去会让它
 *   同时承担两层职责 —— 将来这条规则要调整（比如改成按周去重、
 *   或引入语义相似度）时，改动会落在数据访问层里，那是错的层次。
 *
 *   这里只组合仓库层提供的原子操作：
 *     findSameDayEventByTitle + createEvent
 *
 * 【事件的去重与记忆的去重是两套机制】
 *   记忆：有 uq_memories_current_slot 部分唯一索引兜底（有槽位的），
 *         并有 candidate-processor 的语义判定流程。
 *   事件：标题是自然语言，无法做唯一键；也不参与冲突判定。
 *         因此只能做**写入侧的尽力去重**。
 *
 *   抽取按消息区间推进，同一件事在相邻两个区间里都可能被提到 ——
 *   不去重就会在时间线上出现两个一模一样的节点。
 *
 * ⚠️ 已知局限：这是尽力而为，不是强保证：
 *    · 标题措辞略有不同（「换工作到字节」vs「入职字节」）就判不出来
 *    · 用精确匹配而不是相似度，是为了避免在写入热路径上引入 embedding 调用
 *    若将来漏判严重，正确做法是在库层加部分唯一索引 ——
 *    那需要先改 docs/03（AGENTS.md §4.1）。
 */
import {
  createEvent,
  findSameDayEventByTitle,
} from '../database/repository/event-store.js';
import type { ExecutorOption } from '../database/repository/types.js';
import type { EventCategory } from '../database/schema/enums.js';
import type { CandidateEvent } from './extraction-schema.js';

export interface WriteExtractedEventsResult {
  created: number;
  /** 因「同一天已有同名事件」被跳过的条数 */
  skippedDuplicates: number;
  /** 时间无法解析被跳过的条数（解析层应已过滤，这里兜底） */
  skippedBadTime: number;
}

/**
 * 写入抽取产出的事件。
 *
 * @param sourceMessageId 来源消息。取抽取区间里的最后一条 ——
 *        事件通常在对话末尾被提到（「我上周换了工作」）。
 *        传 null 表示来源不可考（例如消息已被删除）。
 */
export async function writeExtractedEvents(
  params: {
    userId: string;
    events: CandidateEvent[];
    sourceMessageId: string | null;
  },
  options: ExecutorOption = {}
): Promise<WriteExtractedEventsResult> {
  let created = 0;
  let skippedDuplicates = 0;
  let skippedBadTime = 0;

  for (const e of params.events) {
    const eventTime = new Date(e.eventTime);
    if (Number.isNaN(eventTime.getTime())) {
      skippedBadTime++;
      continue;
    }

    const duplicate = await findSameDayEventByTitle(
      { userId: params.userId, title: e.title, eventTime },
      options
    );

    if (duplicate) {
      skippedDuplicates++;
      continue;
    }

    await createEvent(
      {
        userId: params.userId,
        title: e.title,
        description: e.description ?? null,
        eventTime,
        category: (e.category ?? null) as EventCategory | null,
        ...(e.importance !== undefined ? { importanceScore: e.importance } : {}),
        sourceType: 'conversation',
        sourceMessageId: params.sourceMessageId,
      },
      options
    );
    created++;
  }

  return { created, skippedDuplicates, skippedBadTime };
}
