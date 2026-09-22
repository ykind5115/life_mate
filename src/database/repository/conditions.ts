/**
 * 共用的查询条件常量
 *
 * 依据：《数据库设计 V1.1》
 *   §13.6 「当前有效记忆」的判定谓词 —— 必须定义一次并全局复用
 *   §18.3 检索过滤条件 —— 所有召回路径统一包含
 *   §29.1 隐私 —— 软删除必须真的从所有召回路径消失
 *
 * 【为什么集中在这里】
 *   §13.6 的原文要求：
 *     「该谓词必须在 Repository 层定义一次并被全局复用，
 *       禁止在业务代码里手写（否则必然漏，导致已删除记忆仍被召回）」
 *
 *   这不是风格要求，而是隐私要求：漏掉一个过滤条件，
 *   用户删除的记忆就可能继续出现在回答里（审计 P1-2）。
 *
 *   因此：**任何查询 memories 的代码都必须引用本文件的常量，
 *   不得自行拼写 status/deleted_at/valid_until/superseded_by 条件。**
 */
import { and, eq, gt, isNull, lte, ne, or, type SQL } from 'drizzle-orm';

import { memories } from '../schema/memories.js';

/**
 * 「当前有效记忆」判定谓词（§13.6）。
 *
 * 四个条件缺一不可：
 *   status = 'active'        排除 conflict / superseded / archived / deleted
 *   deleted_at IS NULL       排除用户软删除的
 *   valid_until IS NULL      排除事实上已失效的（双时间轴）
 *   superseded_by IS NULL    排除已被新记忆替代的
 *
 * ⚠️ 注意 status='active' 已隐含排除 'conflict'（C35）：
 *    冲突记忆照常入库但不被召回，等用户裁决。
 */
export function currentMemoryCondition(): SQL {
  return and(
    eq(memories.status, 'active'),
    isNull(memories.deletedAt),
    isNull(memories.validUntil),
    isNull(memories.supersededBy)
  )!;
}

/**
 * 历史查询谓词：某个时间点上成立的事实（§13.6）。
 *
 * 用途：时间线回溯、「我什么时候开始想做这个项目」这类问题。
 * 与上面的区别：不看当前 status，而看事实时间区间是否覆盖目标时刻。
 *
 * @param at 目标时刻（业务时间）
 */
export function memoryValidAtCondition(at: Date): SQL {
  return and(
    // valid_from 为空视为「一直以来」（抽取时未确定起点）
    or(isNull(memories.validFrom), lte(memories.validFrom, at))!,
    or(isNull(memories.validUntil), gt(memories.validUntil, at))!,
    isNull(memories.deletedAt)
  )!;
}

/**
 * 「未被用户删除」谓词。
 *
 * 用于不该受 status 影响、但仍必须排除删除记录的场合
 * （例如管理页需要看到 conflict / archived 的记忆，但不能看到已删除的）。
 */
export function notDeletedCondition(): SQL {
  return and(isNull(memories.deletedAt), ne(memories.status, 'deleted'))!;
}

/**
 * 「待用户裁决的冲突记忆」谓词（C35）。
 *
 * 用户在前端审阅冲突时使用。这些记忆不参与召回。
 */
export function conflictMemoryCondition(): SQL {
  return and(eq(memories.status, 'conflict'), isNull(memories.deletedAt))!;
}
