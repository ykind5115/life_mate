/**
 * Memory Repository 的输入类型
 *
 * 单独成文件的原因：写操作与读操作的输入形状不同，
 * 且写操作的字段必须显式区分「哪些可写、哪些由系统维护」，
 * 把「不可变字段」混进入参类型会让调用方以为可以改（§13.1 的 C25）。
 */
import type {
  MemoryPolarity,
  MemoryStatus,
  MemoryType,
  SourceType,
} from '../schema/enums.js';

/**
 * 记忆的来源指针。
 *
 * 至少一个指针非空，或 sourceType 为 manual/system（§15.4 的
 * chk_sources_has_origin）。库层会拦住违规写入，这里不重复校验，
 * 但类型上鼓励调用方明确来源。
 */
export interface MemorySourceInput {
  sourceType: SourceType;
  /** 来源消息。conversation 来源时应提供 */
  messageId?: string;
  eventId?: string;
  goalId?: string;
}

/**
 * 新建记忆的输入。
 *
 * ⚠️ 刻意不含以下字段（由系统维护或不可变）：
 *   status / validUntil / supersededBy / deletedAt / sourceCount
 *   created_at / updated_at
 */
export interface CreateMemoryInput {
  userId: string;
  type: MemoryType;
  /** 展示给用户的正文。创建后不可变 */
  content: string;

  // ---------- 结构化槽位（Q2）----------
  /** 规范化主体。V1.0 单用户场景通常为 'user' */
  subjectKey?: string;
  /**
   * 规范化槽位，取自受控词表 PREDICATE_KEYS。
   *
   * 留空表示该记忆不参与冲突判定（§13.7）——
   * 词表之外的信息只存储，不强判。
   */
  predicateKey?: string;
  objectValue?: string;
  polarity?: MemoryPolarity;

  // ---------- 评分 ----------
  importanceScore?: number;
  confidenceScore?: number;

  /** 事实生效时间（业务时间）。不传则视为「自记录起」 */
  validFrom?: Date;

  /** 来源。可传多个，表示这条记忆由多处信息共同支撑 */
  sources: MemorySourceInput[];
}

/**
 * 冲突裁决结果（C35）。
 *
 * 用户在「memory A 对」/「memory B 对」/「两者共存」之间选择后，
 * 由服务层调用对应方法落地。
 */
export type ConflictResolution =
  | {
      /** 采纳新记忆：新记忆转 active，旧记忆置 superseded */
      kind: 'accept_new';
      conflictMemoryId: string;
      supersededMemoryId: string;
    }
  | {
      /** 采纳旧记忆：冲突记忆转 archived（保留为历史，不召回） */
      kind: 'keep_old';
      conflictMemoryId: string;
    }
  | {
      /** 判定可共存：修正 predicate_key 后重新判定，不在此处理 */
      kind: 'coexist';
      conflictMemoryId: string;
    };

/** 列表查询过滤条件 */
export interface ListMemoriesFilter {
  userId: string;
  type?: MemoryType;
  status?: MemoryStatus[];
  /** 是否包含无槽位的记忆。默认包含 */
  includeSlotless?: boolean;
  limit?: number;
  offset?: number;
}
