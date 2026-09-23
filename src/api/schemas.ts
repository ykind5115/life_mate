/**
 * 请求校验 schema（docs/04 §39、§40）
 *
 * 【原则】任何来自客户端的数据都不能直接进入数据库。
 *
 * 【命名口径】
 *   API 层用 snake_case（docs/04 的请求体就是 snake_case：conversation_id）
 *   TypeScript 内部用 camelCase。转换只在本文件做，route 里拿到的是 camelCase。
 */
import { z } from 'zod';

import { MESSAGE_ROLES, PREDICATE_KEYS } from '../database/schema/enums.js';

// ============================================================
// 基础
// ============================================================

/**
 * 消息长度上限。
 *
 * 5000 与 docs/04 §39 的 createMemorySchema 一致。
 * ⚠️ 这是**防止异常输入**的上限，不是产品限制：
 *    超过它的输入应被拒绝并告知用户，而不是静默截断 ——
 *    截断会让用户以为系统看到了完整内容。
 */
export const MAX_MESSAGE_LENGTH = 5000;
export const MAX_TITLE_LENGTH = 200;

export const uuidSchema = z.string().uuid('必须是合法的 UUID');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

// ============================================================
// Chat（docs/04 §9）
// ============================================================

export const chatRequestSchema = z.object({
  /**
   * 可以为空 —— 为空时会新建会话（docs/04 §9.2）。
   *
   * 允许 null 是刻意的：前端「新对话」按钮最自然的表达就是传 null。
   * 但**不允许空字符串** —— 那通常是前端 bug，当成空值处理会掩盖它。
   */
  conversation_id: uuidSchema.nullish(),
  message: z
    .string()
    .min(1, '消息不能为空')
    .max(MAX_MESSAGE_LENGTH, `消息长度不能超过 ${MAX_MESSAGE_LENGTH} 字符`)
    // 全空白消息没有语义，且会让抽取器困惑
    .refine((v) => v.trim().length > 0, { message: '消息不能只有空白字符' }),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** 转成 ChatService 的入参形状 */
export function toChatParams(body: ChatRequest): {
  conversationId: string | null;
  message: string;
} {
  return {
    conversationId: body.conversation_id ?? null,
    message: body.message,
  };
}

// ============================================================
// Conversations（docs/04 §12–§16）
// ============================================================

export const listConversationsQuerySchema = paginationSchema.extend({
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const conversationIdParamSchema = z.object({ id: uuidSchema });

export const conversationMessagesQuerySchema = paginationSchema.extend({
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateConversationSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
  })
  .strict();

/**
 * 删除会话的语义（docs/03 §24.2 的两种语义）。
 *
 * ⚠️ 文档明确要求「前端需明确提示两种语义的差异」，
 *    因此这里**没有默认值陷阱**：缺省是 keep（保守：不删数据），
 *    想删派生记忆必须显式传 delete_derived_memories=true。
 */
export const deleteConversationQuerySchema = z.object({
  delete_derived_memories: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

// ============================================================
// Memories（docs/04 §18–§26）
// ============================================================

/**
 * 用户可手工创建的记忆类型。
 *
 * ⚠️ 刻意不含 goal 与 event（审计 F-06）：
 *    它们有专用实体（goals / events 表），直接创建记忆会造成
 *    「同一个目标有两处真相」，且绕过各自的生命周期状态机。
 *    正确路径是 POST /api/v1/goals 与 POST /api/v1/events（V1.0 未实现）。
 */
export const CREATABLE_MEMORY_TYPES = ['fact', 'preference', 'relationship', 'state'] as const;

export const listMemoriesQuerySchema = paginationSchema.extend({
  type: z.enum(['fact', 'preference', 'event', 'goal', 'relationship', 'state']).optional(),
  /** 逗号分隔的状态列表，如 status=conflict,archived */
  status: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
    )
    .pipe(
      z
        .array(z.enum(['active', 'conflict', 'superseded', 'archived', 'deleted']))
        .optional()
    ),
  /** 管理页需要看到 conflict / archived，默认口径不同 */
  view: z.enum(['current', 'management']).default('current'),
});

export const searchMemoriesQuerySchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const memoryIdParamSchema = z.object({ id: uuidSchema });

export const createMemorySchema = z
  .object({
    type: z.enum(CREATABLE_MEMORY_TYPES),
    content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
    /**
     * 可选槽位。用户手工创建时通常不知道槽位该填什么，
     * 因此允许省略；填了则必须是受控词表内的值。
     */
    subject_key: z.string().min(1).max(64).optional(),
    predicate_key: z.enum(PREDICATE_KEYS).optional(),
    object_value: z.string().min(1).max(500).optional(),
    polarity: z.enum(['affirm', 'deny']).optional(),
  })
  .strict();

/**
 * 更新记忆。
 *
 * ⚠️ 这是一个需要停下来讨论的接口设计问题，此处按保守口径实现：
 *    docs/04 §23 说 PATCH /memories/:id 可以改 content，并「重新生成 Embedding」。
 *    但 Q1 已锁定「记忆正文永不就地修改」，docs/03 §13.1 也明确禁止
 *    UPDATE memories.content —— 改内容会让 valid_from 语义二义，
 *    并让「用户过去住在广州」这段历史消失。
 *
 *    因此本接口**只允许改系统认知类字段**（重要度），
 *    改 content 会返回 422 并提示改用「替代」语义（创建新记忆 + 失效旧记忆）。
 *    这属于文档冲突，已在交付说明里回报，不要在未确认前放开。
 */
export const updateMemorySchema = z
  .object({
    importance_score: z.number().min(0).max(1).optional(),
  })
  .strict();

// ============================================================
// Settings（docs/04 §34–§36）
// ============================================================

/**
 * ⚠️ 枚举值必须与 docs/03 §8.4 的白名单一致：
 *      response_style  → direct | gentle | detailed
 *      response_length → short | medium | long
 *    本文件第一版把 response_style 写成了 `concise | detailed` —— 那是臆造的，
 *    会让前端按文档传 `direct` 时被 422 拒掉。
 *    settings 里的键值以 §8.4 为唯一依据。
 *
 * `.strict()`：白名单模式（§16.3），多传未知键应报错而不是静默丢弃 ——
 * 静默丢弃会让调用方以为设置生效了。
 */
export const updateSettingsSchema = z
  .object({
    memory: z
      .object({
        auto_extract: z.boolean(),
      })
      .strict()
      .optional(),
    /** IANA 时区名，如 Asia/Shanghai。对应 users.timezone 列 */
    timezone: z.string().min(1).max(64).optional(),
    response_style: z.enum(['direct', 'gentle', 'detailed']).optional(),
    response_length: z.enum(['short', 'medium', 'long']).optional(),
    display_name: z.string().min(1).max(100).optional(),
    locale: z.string().min(1).max(20).optional(),
  })
  .strict();

// ============================================================
// Timeline / Event（docs/04 §27–§30）
// ============================================================

/**
 * 事件分类。
 *
 * ⚠️ 直接从 enums.ts 导出，不在这里重写一份：
 *    库层有 chk_events_category 的 CHECK（C37），
 *    两处枚举各写一份必然漂移 —— 加一个类别就要改两个地方，
 *    漏掉一处时前端会传一个被库层拒绝的值。
 */
export { EVENT_CATEGORIES as TIMELINE_CATEGORIES } from '../database/schema/enums.js';

/**
 * 日期参数。
 *
 * 接受 `YYYY-MM-DD` 或完整 ISO 8601。
 * 不做 .datetime() 强校验的原因：docs/04 §27 的示例就是 `?start=2026-01-01`，
 * 强校验会把它拒掉。
 */
const dateParamSchema = z.string().min(1).max(40);

export const timelineQuerySchema = paginationSchema.extend({
  start: dateParamSchema.optional(),
  end: dateParamSchema.optional(),
  category: z
    .enum(['work', 'study', 'project', 'life', 'health', 'other'])
    .optional(),
});

export const timelineEventIdParamSchema = z.object({ id: uuidSchema });

export const createTimelineEventSchema = z
  .object({
    title: z.string().min(1, '标题不能为空').max(MAX_TITLE_LENGTH),
    description: z.string().max(2000).nullish(),
    /** 事件发生时间。必填 —— event_time 是 NOT NULL，没有时间的事件无法上时间线 */
    event_time: z.string().min(1, 'event_time 不能为空'),
    category: z.enum(['work', 'study', 'project', 'life', 'health', 'other']).nullish(),
    importance_score: z.number().min(0).max(1).optional(),
    timeline_visible: z.boolean().optional(),
  })
  .strict();

/**
 * 更新事件。
 *
 * ⚠️ 与记忆的 PATCH 形成对比，这里**允许改内容**：
 *    Q1 的「不可变事实」约束针对 memories（要参与冲突判定与历史查询）。
 *    事件是用户人生经历的记录，标题写错了就该能改 ——
 *    docs/04 §29 也给了这个端点。
 *    允许改：title / description / event_time / category /
 *            importance_score / timeline_visible
 *    不允许改：source_type / source_message_id（来源凭证）与 created_at
 */
export const updateTimelineEventSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: z.string().max(2000).nullish(),
    event_time: z.string().min(1).optional(),
    category: z.enum(['work', 'study', 'project', 'life', 'health', 'other']).nullish(),
    importance_score: z.number().min(0).max(1).optional(),
    timeline_visible: z.boolean().optional(),
  })
  .strict();

// ============================================================
// Life Review（docs/04 §31–§33）
// ============================================================

/**
 * 生成生活回顾。
 *
 * docs/04 §31 的示例只给了 start / end。
 * 这里额外支持 kind=day|week|month —— PRD §7.6 明确要求
 * 「日回顾 / 周回顾 / 月回顾 / 时间范围回顾」四种，
 * 只给自定义区间的话前端要自己算周一到周日，
 * 而「一周从哪天开始」这种约定不该散落在前端。
 *
 * 两种用法：
 *   { "kind": "week" }                          回顾本周
 *   { "start": "...", "end": "..." }            回顾指定区间
 *   { "kind": "month", "at": "2026-08-15" }     回顾 2026 年 8 月
 */
export const lifeReviewRequestSchema = z
  .object({
    kind: z.enum(['day', 'week', 'month', 'custom']).optional(),
    /** 参考时间点。缺省为现在。用于回顾「上个月的」而非「此刻所在月」 */
    at: z.string().min(1).optional(),
    /** kind=custom（或省略 kind）时的区间 */
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (v) => {
      /**
       * 省略 kind 时按 custom 处理，因此必须给 start/end。
       * 这个 refine 把「参数不全」在入口处拦下 ——
       * 否则会走到 service 里抛一个 500。
       */
      if (v.kind === undefined || v.kind === 'custom') {
        return v.start !== undefined && v.end !== undefined;
      }
      return true;
    },
    { message: 'kind 为 custom 或省略时必须同时提供 start 与 end' }
  );

// ============================================================
// 内部再导出，供 route 做枚举校验
// ============================================================

export { MESSAGE_ROLES };
