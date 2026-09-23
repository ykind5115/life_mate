/**
 * 记忆抽取的输出契约（Q2 决策的落地）
 *
 * 依据：docs/03 §13.7、docs/01 §8.1~§8.4
 *
 * 【为什么必须是结构化的，而不是自由文本】
 *   冲突判定的最小单位不是「一条记忆文本」，而是「同一槽位上的两个取值」。
 *   向量相似度无法区分「相似」与「矛盾」——这两者是正交维度：
 *
 *     记忆 A：用户住在广州       字面不相似
 *     记忆 B：用户已经搬到深圳   → 却真冲突
 *
 *     记忆 C：用户计划学 Python   语义高度相似
 *     记忆 D：用户在用 TypeScript → 却可共存
 *
 *   没有 subject/predicate 信息，系统就没有确定性依据，
 *   只能完全依赖 LLM 临场判断，而那个判断不可复现、无法回归测试。
 *   （审计 P0-2）
 *
 * ------------------------------------------------------------
 * 【契约分级策略】—— 2026-09-22 据实测修订
 * ------------------------------------------------------------
 * 实测遇到过一次偶发失败：模型给了 predicateKey 却漏 objectValue，
 * 而当时的实现**整批抛错**，把同一批里 5 条完全合格的记忆一起丢掉。
 *
 * 这暴露了处理策略上的粗放：不同性质的异常应该有不同的后果。
 *
 * 分三级：
 *
 *   ① 容器级错误 → **整批失败**（抛错）
 *      JSON 无法解析、顶层结构不是对象、memories 不是数组。
 *      此时没有任何可信数据，静默返回空会被上层当成
 *      「这段对话没有值得记的内容」而**永久丢失记忆** —— 最危险的失败模式。
 *
 *   ② 条目级错误 → **丢弃该条，保留其余**
 *      type 不在枚举内、content 为空或超长。
 *      该条内容无法使用；但同批其他条目与它无关。
 *
 *   ③ 字段级错误 → **降级该字段，保留该条**
 *      槽位问题（词表外的 predicateKey、有槽位无取值、有取值无槽位）。
 *
 *      ⚠️ 为什么槽位问题只降级不丢条目：
 *         §13.7 的原则是「词表之外的信息不参与冲突判定，只存储」。
 *         记忆的**内容有价值**，没槽位只是不能参与冲突判定而已 ——
 *         降级成无槽位记忆（只存储、不判冲突）正是文档规定的行为。
 *         丢掉整条反而违背了这条原则。
 *
 *      ⚠️ 但要**记录诊断**：降级不该静默。
 *         槽位命中率是「结构化抽取是否有效」的直接指标，
 *         若模型频繁给词表外槽位，说明提示词或词表需要调整 ——
 *         这个信号必须能被看见（见 ExtractionDiagnostics）。
 */
import { z } from 'zod';

import {
  MEMORY_TYPES,
  MEMORY_POLARITIES,
  PREDICATE_KEYS,
  EVENT_CATEGORIES,
} from '../database/schema/enums.js';

/**
 * 抽取器返回的单条候选记忆。
 *
 * 字段说明中的「缺省行为」很重要：LLM 常会漏字段或给多余字段。
 */
export const candidateMemorySchema = z.object({
  /** 记忆类型。非法值 → 该条被丢弃（条目级错误） */
  type: z.enum(MEMORY_TYPES),

  /**
   * 展示给用户的自然语言正文。
   *
   * 要求：完整、自足、以「用户」为主语。
   * ❌ 不要写「他」「这个」等依赖上下文的指代 —— 记忆脱离对话后必须可独立理解。
   */
  content: z.string().min(1).max(500),

  /**
   * 规范化主体。V1.0 单用户场景固定为 'user'。
   * 缺省由调用方补 'user'。
   */
  subjectKey: z.string().max(100).optional(),

  /**
   * 规范化槽位，**必须来自受控词表**（§13.7）。
   *
   * ⚠️ 用 .catch(null) 做**字段级降级**而不是让整条失败：
   *    词表外的槽位会被收敛为 null（即「无槽位」），
   *    该记忆仍然入库、只是不参与冲突判定。
   *    这符合 §13.7「词表之外的信息不参与冲突判定，只存储」。
   *    降级事实会被记录进 diagnostics，不静默。
   *
   * ⚠️ 用 union 而**不是** `.optional().catch(null)`：
   *    `.optional()` 会把输出类型收窄成 `enum | undefined`，
   *    于是 `.catch(null)` 不接受 null（类型不通过）；
   *    而 `.catch(null).optional()` 又会让 undefined 被 optional
   *    当作合法输入放行、catch 不触发，字段保持 undefined 而非 null，
   *    下游的成对判定随之失效（实测踩到）。
   *    union 让 `enum | null | undefined` 都是合法输出，catch 兜住其余。
   */
  predicateKey: z.union([z.enum(PREDICATE_KEYS), z.null(), z.undefined()]).catch(null),

  /** 规范化取值。与 predicateKey 配对使用 */
  objectValue: z.union([z.string().max(500), z.null(), z.undefined()]).catch(null),

  /** 极性。缺省视为 affirm（肯定表述） */
  polarity: z.enum(MEMORY_POLARITIES).optional(),

  /** 重要性 0~1。越界收敛到边界值而不是失败 */
  importance: z.number().min(0).max(1).catch(0.5).optional(),

  /** 置信度 0~1。越界收敛 */
  confidence: z.number().min(0).max(1).catch(1).optional(),

  /**
   * 该记忆所依据的原文片段。
   *
   * ⚠️ 注意：这只是**给人和评测看的文本**，不是来源指针。
   *    来源追踪靠 memory_sources.message_id，由编排层提供
   *    （见 candidate-processor 的 source 参数说明）。
   */
  evidence: z.string().max(500).optional(),
});

/**
 * 抽取器返回的单条候选事件（docs/03 §20、§20.4）。
 *
 * 【为什么事件与记忆在同一次调用里产出，而不是各调一次】
 *   事件与记忆是从**同一段对话**里读出来的两类东西：
 *     Memory「用户正在学习 TypeScript」  → 不一定是事件
 *     Event 「2026-09 开始学习 TS」      → 有明确时间点、构成人生节点
 *   分两次调用等于让模型把同样的对话读两遍，成本翻倍且两次判断可能不一致。
 *   §20.4 明确二者「允许独立存在、不强制绑定」，因此一次读、分别输出最自然。
 *
 * 【与记忆的关键差异：事件必须有时间】
 *   event_time 是 NOT NULL（§20.2）。没有时间的事件在时间线上无处安放。
 *   因此 eventTime 是**必填**，模型给不出相对时间的换算时，
 *   由调用方用对话发生时间兜底（见 normalizeCandidateEvent）。
 *
 * 【title 与 description 的分工】
 *   title 要短（时间线上显示），description 可长（点开看详情）。
 *   让模型自己判断详略，比我们截断更合理 —— 截断会把一句话切成半截。
 */
export const candidateEventSchema = z.object({
  /** 事件名称。时间线上显示的就是它，因此要短 */
  title: z.string().min(1).max(200),

  /** 事件描述。可空 */
  description: z.union([z.string().max(1000), z.null(), z.undefined()]).catch(null),

  /**
   * 事件发生时间，ISO 8601 字符串。
   *
   * ⚠️ 要求模型输出**绝对时间**而不是「上周三」：
   *    提示词里会给出对话发生的日期，让它自行换算。
   *    相对时间无法落库（event_time 是 TIMESTAMPTZ），
   *    而且记忆会在几周后被检索到，那时「上周三」已经无法解析。
   */
  eventTime: z.string().min(1),

  /**
   * 分类。词表外或缺失 → 降级为 null（不强制归类，§20.2 的 C37 说明）。
   *
   * ⚠️ 不在这里把词表外的值改成 'other'：
   *    那是**存储策略**，应由 normalizeCandidateEvent 决定并留下诊断。
   *    schema 层只负责把非法值收敛成 null。
   */
  category: z.union([z.enum(EVENT_CATEGORIES), z.null(), z.undefined()]).catch(null),

  /** 重要性 0~1。越界收敛 */
  importance: z.number().min(0).max(1).catch(0.5).optional(),

  /** 依据的原文片段，供人工核查 */
  evidence: z.string().max(500).optional(),
});

export interface CandidateEvent {
  title: string;
  description?: string | null | undefined;
  eventTime: string;
  category?: (typeof EVENT_CATEGORIES)[number] | null | undefined;
  importance?: number | undefined;
  evidence?: string | undefined;
}

/**
 * 候选记忆的类型。
 *
 * ⚠️ 手写接口而不是 `z.infer<typeof candidateMemorySchema>`：
 *    因为 predicateKey / objectValue 用了 .catch(null)，
 *    推导出的类型里这两个字段是**必有**的（值为 `... | null`），
 *    而手写接口能把「解析后的形状」与「构造测试数据的形状」分开表达 ——
 *    optional 的部分写 `| undefined`，让测试可以直接构造字面量而不必补齐每个字段。
 *
 * 两者形状兼容（`.catch()` 保证解析结果填满这些字段），
 * 因此 safeParse 的结果可直接赋给本类型。
 */
export interface CandidateMemory {
  type: (typeof MEMORY_TYPES)[number];
  content: string;
  subjectKey?: string | undefined;
  /** 解析后必有：合法槽位 / null（词表外或缺失，已降级） */
  predicateKey?: (typeof PREDICATE_KEYS)[number] | null | undefined;
  /** 解析后必有：取值 / null（缺失，已降级） */
  objectValue?: string | null | undefined;
  polarity?: (typeof MEMORY_POLARITIES)[number] | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  evidence?: string | undefined;
}

/** 抽取器返回的完整结果 */
export const extractionResultSchema = z.object({
  /**
   * 候选记忆列表。可以为空 —— 大部分闲聊不该形成长期记忆（§13 的提取原则）。
   *
   * ⚠️ 单条失败不应导致整条列表失败（见文件头的分级策略）。
   *    做法：先用宽松类型接收，再逐条校验、丢弃不合格的。
   */
  memories: z.array(z.unknown()).max(50),

  /**
   * 候选事件列表（docs/03 §20）。
   *
   * ⚠️ 用 `.optional()` 而不是必填：旧版提示词、或模型只返回 memories 时，
   *    整批不该失败 —— 事件是**附加**产出，不是记忆抽取成立的前提。
   *    这与 memories 的容器级严格性不同，是刻意的：
   *    memories 缺失意味着抽取根本没成功；events 缺失只是这类信息为空。
   */
  events: z.array(z.unknown()).max(20).optional(),

  /**
   * 抽取器的简短说明（1~2 句）。
   * 用途：调试提示词效果、人工核查时快速理解模型意图。
   * ⚠️ 不落库、不展示给用户。
   */
  note: z.string().max(300).optional(),
});

/** 单条候选被丢弃的诊断记录 */
export interface DroppedCandidate {  /** 在原始数组中的下标，便于对照原始输出排查 */
  index: number;
  /** 丢弃原因（人类可读） */
  reason: string;
  /** 精简后的原始内容，用于判断「丢的是什么」 */
  rawPreview: string;
}

/** 字段降级的诊断记录 */
export interface FieldDegradation {
  index: number;
  field: string;
  /** 原始值（字符串化，便于排查） */
  original: string;
  /** 降级后的处理 */
  action: string;
}

/**
 * 抽取诊断。
 *
 * 存在的意义：**降级不该静默**。
 * 若模型频繁给词表外槽位或不合格条目，说明提示词或词表需要调整 ——
 * 这个信号必须能被观测到，否则抽取质量会在无人察觉中退化。
 * （对应 PRD §15 的 Memory Precision / Noise 指标，是它们的早期预警）
 */
export interface ExtractionDiagnostics {
  /** 原始候选项数（模型声称抽出的条数） */
  rawCount: number;
  /** 通过校验的条数 */
  validCount: number;
  /** 因条目级错误被丢弃的 */
  dropped: DroppedCandidate[];
  /** 因字段级问题被降级的 */
  degradations: FieldDegradation[];
  /** 槽位命中情况：有槽位的条数 / 有效条数 */
  slotCoverage: { withSlot: number; total: number };
  /** 事件抽取情况。与记忆分开记账 —— 两者的失败模式不同 */
  events: {
    rawCount: number;
    validCount: number;
    /** 因时间无法解析被丢弃的事件数 */
    droppedForBadTime: number;
    /** 分类不在词表内、降级为 other 的条数 */
    categoryFallbacks: number;
  };
}

/** 解析结果：数据 + 诊断 */
export interface ParseOutcome {
  result: ExtractionResult;
  diagnostics: ExtractionDiagnostics;
}

/**
 * 全零诊断。
 *
 * 抽出来单独一个函数而不是让各处自己写字面量：
 *  ExtractionDiagnostics 每加一个字段（如本次加 events），
 *  所有手写字面量的地方都会类型报错 —— 那是好事，但改起来是重复劳动。
 *  更重要的是**空诊断的语义必须一致**（「什么都没发生」），
 *  散落多处迟早出现某个字段忘了置零的情况。
 */
export function emptyDiagnostics(): ExtractionDiagnostics {
  return {
    rawCount: 0,
    validCount: 0,
    dropped: [],
    degradations: [],
    slotCoverage: { withSlot: 0, total: 0 },
    events: { rawCount: 0, validCount: 0, droppedForBadTime: 0, categoryFallbacks: 0 },
  };
}

export type ExtractionResult = {
  memories: CandidateMemory[];
  events: CandidateEvent[];
  note?: string;
};

/**
 * 宽松解析：从 LLM 的原始文本中提取 JSON，按分级策略处理异常。
 *
 * 需要处理的现实情况（都实测过或属常见模式）：
 *   ① 模型把 JSON 包在 ```json 代码块里
 *   ② JSON 前后有解释性文字
 *   ③ 顶层是数组而非对象
 *   ④ 单条候选不合格（应丢弃该条而不是整批）
 *   ⑤ 槽位不合格（应降级该字段而不是丢条）
 */
export function parseExtractionResultWithDiagnostics(
  raw: string,
  params: {
    /**
     * 对话发生时间。当前未用于兜底（见 parseCandidateEvents 的说明），
     * 保留为参数是为了让调用方显式表态，也便于将来若改变策略时不必改签名。
     */
    conversationTime?: Date;
  } = {}
): ParseOutcome {
  const jsonText = extractJsonBlock(raw);

  // ---------- ① 容器级：JSON 必须能解析 ----------
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `抽取结果不是合法 JSON（容器级错误，整批失败）。\n` +
        `原始输出前 200 字：${raw.slice(0, 200)}\n` +
        `解析错误：${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 容忍模型直接返回数组
  const normalized = Array.isArray(parsed) ? { memories: parsed } : parsed;

  // ---------- ② 容器级：顶层结构必须合规 ----------
  const container = extractionResultSchema.safeParse(normalized);
  if (!container.success) {
    const issues = container.error.issues
      .slice(0, 5)
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `抽取结果的顶层结构不符合契约（容器级错误，整批失败）：\n${issues}\n` +
        `原始输出前 300 字：${raw.slice(0, 300)}`
    );
  }

  const rawItems = container.data.memories;

  // ---------- ③④ 逐条校验：条目级错误丢弃该条 ----------
  const memories: CandidateMemory[] = [];
  const dropped: DroppedCandidate[] = [];
  const degradations: FieldDegradation[] = [];

  for (const [index, item] of rawItems.entries()) {
    const check = candidateMemorySchema.safeParse(item);

    if (!check.success) {
      dropped.push({
        index,
        reason: summarizeIssues(check.error.issues),
        rawPreview: previewOf(item),
      });
      continue;
    }

    const candidate = check.data;

    // 字段级：槽位不成对时降级（保留记忆、去掉槽位）
    const slot = reconcileSlot(candidate, index, item, degradations);
    memories.push(slot);
  }

  const withSlot = memories.filter(
    (m) => m.predicateKey !== null && m.predicateKey !== undefined && m.objectValue
  ).length;

  // ---------- ⑤ 事件：同样的分级策略 ----------
  const eventsOutcome = parseCandidateEvents(
    container.data.events ?? [],
    params.conversationTime
  );

  return {
    result: {
      memories,
      events: eventsOutcome.events,
      ...(container.data.note !== undefined ? { note: container.data.note } : {}),
    },
    diagnostics: {
      rawCount: rawItems.length,
      validCount: memories.length,
      dropped,
      degradations,
      slotCoverage: { withSlot, total: memories.length },
      events: eventsOutcome.diagnostics,
    },
  };
}

/**
 * 解析候选事件。
 *
 * 分级策略与记忆一致：容器级（events 不是数组）已在 schema 层处理为容器错误；
 * 这里只做条目级（丢弃单条）与字段级（降级分类）。
 *
 * 【时间解析是最关键的一步】
 *   event_time 是 NOT NULL，且相对时间（「上周三」）无法落库。
 *   因此：
 *     · 能解析成绝对时间的 → 采用
 *     · 解析不了的 → 丢弃该事件并记录原因
 *
 *   ⚠️ 为什么不「解析不了就用对话时间兜底」：
 *      那会把「三年前开始学琴」写成对话发生的时间，
 *      在时间线上是个**错误的节点** —— 比缺一个节点更糟。
 *      时间线错位会让用户觉得"它记错了我的生活"。
 *      宁可少一个节点，也不要一个时间错误的节点。
 *
 *   提示词里已给出对话发生时间让模型自己换算，因此正常情况不需要兜底。
 */
export function parseCandidateEvents(
  rawEvents: unknown[],
  conversationTime?: Date
): {
  events: CandidateEvent[];
  diagnostics: ExtractionDiagnostics['events'];
} {
  const events: CandidateEvent[] = [];
  let droppedForBadTime = 0;
  let categoryFallbacks = 0;

  for (const item of rawEvents) {
    const check = candidateEventSchema.safeParse(item);
    if (!check.success) {
      droppedForBadTime++; // 多数是时间缺失或标题为空
      continue;
    }

    const candidate = check.data;
    const parsedTime = resolveEventTime(candidate.eventTime, conversationTime);
    if (parsedTime === null) {
      droppedForBadTime++;
      continue;
    }

    /**
     * 分类降级：模型给了词表外的值（已被 .catch(null) 收敛成 null）
     * 或干脆没给，且**事件确实存在**时写 'other'。
     *
     * §20.2 的 C37 明确要求：'other' 是兜底值 ——
     * 「遇到无法归类的真实事件时写 'other'，而不是编造枚举外的值，
     *   也不是弃之不存」。因此这里补 'other' 而不是留 null。
     */
    let category = candidate.category ?? null;
    if (category === null) {
      category = 'other';
      categoryFallbacks++;
    }

    events.push({
      title: candidate.title,
      description: candidate.description ?? null,
      eventTime: parsedTime.toISOString(),
      category,
      importance: candidate.importance,
      evidence: candidate.evidence,
    });
  }

  return {
    events,
    diagnostics: {
      rawCount: rawEvents.length,
      validCount: events.length,
      droppedForBadTime,
      categoryFallbacks,
    },
  };
}

/**
 * 把模型给出的时间字符串解析成 Date。
 *
 * 容忍几种常见形态：
 *   · 完整 ISO 8601             2026-09-10T00:00:00+08:00
 *   · 只有日期                  2026-09-10
 *   · 带中文字的时间描述         2026年9月10日  ← 实测模型会这样输出
 *
 * @returns 解析结果；无法解析返回 null（调用方应丢弃该事件）
 */
export function resolveEventTime(
  raw: string,
  _conversationTime?: Date
): Date | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // 中文字日期 → ISO 形式
  const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(text);
  if (cn) {
    const [, y, m, d] = cn;
    const date = new Date(
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00Z`
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 「2026年9月」这种只有年月 → 取该月 1 号
  const cnMonth = /^(\d{4})年(\d{1,2})月$/.exec(text);
  if (cnMonth) {
    const [, y, m] = cnMonth;
    const date = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 只有日期（YYYY-MM-DD）→ 按 UTC 零点
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 标准 ISO 与其他 Date 能认的格式
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;

  /**
   * 拒绝明显不合理的时间：早于 1900 或晚于未来 1 年。
   *
   * 为什么需要：模型偶尔会把「2026」当成时间戳（1970 年附近），
   * 或把相对时间算错成很远的未来。这类值会污染时间线排序，
   * 而且看起来像是系统坏了。
   */
  const year = date.getUTCFullYear();
  if (year < 1900) return null;
  if (date.getTime() > Date.now() + 365 * 24 * 3600 * 1000) return null;

  return date;
}

/**
 * 槽位字段的一致性调和（字段级降级）。
 *
 * §13.7 的判定流程要求 predicateKey 与 objectValue **成对存在**：
 * 只有槽位没有取值，或只有取值没有槽位，都无法参与冲突判定。
 *
 * 处理选择：**降级为无槽位记忆**，而不是丢弃整条，也不是保留半残的槽位。
 *   · 丢整条 → 违背「词表外信息只存储不判定」的原则，白丢一条有价值的内容
 *   · 保留半残 → 判定流程会在 predicateKey 非空但 objectValue 为空时
 *     走「无槽位」分支，行为上等价于降级，但数据库里留下一个
 *     有槽位无取值的记录，让后续按槽位聚合的统计产生歧义
 */
function reconcileSlot(
  candidate: CandidateMemory,
  index: number,
  rawItem: unknown,
  degradations: FieldDegradation[]
): CandidateMemory {
  const key = candidate.predicateKey ?? null;
  const value = candidate.objectValue ?? null;
  const raw = rawItem as Record<string, unknown>;

  // 模型原始给出的 predicateKey 是否被 .catch(null) 收敛掉了？
  const rawKey = raw['predicateKey'];
  const keyWasDroppedByVocab =
    rawKey !== undefined && rawKey !== null && key === null;

  if (keyWasDroppedByVocab) {
    degradations.push({
      index,
      field: 'predicateKey',
      original: String(rawKey),
      action: '不在受控词表内 → 降级为无槽位（仍存储，但不参与冲突判定）',
    });
  }

  // 不成对的情况。
  //
  // ⚠️ keyWasDroppedByVocab 时要跳过「有取值但无槽位」分支：
  //    那是同一个根因（词表外槽位）的第二次记录，会产出误导性诊断 ——
  //    看起来像模型漏给了槽位，实际是它给了个不在词表里的。
  //    诊断信息必须精确，否则排查时会往错误方向找。
  if (key !== null && value === null) {
    degradations.push({
      index,
      field: 'objectValue',
      original: '(缺失)',
      action: '有槽位但无取值 → 一并去掉槽位',
    });
    return { ...candidate, predicateKey: null, objectValue: null };
  }

  if (key === null && value !== null && !keyWasDroppedByVocab) {
    degradations.push({
      index,
      field: 'predicateKey',
      original: '(缺失)',
      action: '有取值但无槽位 → 去掉取值',
    });
    return { ...candidate, objectValue: null };
  }

  // 词表外槽位导致 key 为 null 时，取值也要清掉（避免半残状态），
  // 但**不再重复记录诊断**
  if (key === null && keyWasDroppedByVocab) {
    return { ...candidate, predicateKey: null, objectValue: null };
  }

  return candidate;
}

/** 把 Zod 的问题列表压成一句话，避免诊断信息过长 */
function summarizeIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('；');
}

/** 精简原始条目，便于排查「丢的是什么」 */
function previewOf(item: unknown): string {
  try {
    const s = typeof item === 'string' ? item : JSON.stringify(item);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return '(无法序列化)';
  }
}

/**
 * 兼容入口：只取结果、忽略诊断。
 *
 * ⚠️ 建议生产路径使用 parseExtractionResultWithDiagnostics ——
 *    丢弃与降级的事实需要被看见，否则抽取质量会静默退化。
 *    这个函数保留是为了让「不关心诊断」的调用点（如单测）更简洁。
 */
export function parseExtractionResult(raw: string): ExtractionResult {
  return parseExtractionResultWithDiagnostics(raw).result;
}

/**
 * 从可能带 markdown 包装的文本中取出 JSON 主体。
 */
function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();

  // ① ```json ... ``` 或 ``` ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();

  // ② 前后有解释文字：取第一个 { 到最后一个 }，或第一个 [ 到最后一个 ]
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');

  let start = -1;
  let openChar = '';
  let closeChar = '';

  if (firstBrace === -1 && firstBracket === -1) return trimmed;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else {
    start = firstBrace;
    openChar = '{';
    closeChar = '}';
  }

  const end = trimmed.lastIndexOf(closeChar);
  if (end > start && trimmed[start] === openChar) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

/**
 * 归一化候选记忆：补齐缺省值，产出可直接进入判定流程的形状。
 *
 * ⚠️ 类型上刻意把 polarity / content 等写成**非可选**：
 *    normalizeCandidate 保证这些字段一定有值（polarity 缺省为 affirm）。
 *    若沿用 CandidateMemory 的可选类型，「可能 undefined」会一路传播到
 *    写库调用，在 exactOptionalPropertyTypes 下无法通过类型检查 ——
 *    而那正是这里要表达的实事：归一化之后就不该再有 undefined。
 */
export interface NormalizedCandidate {
  type: CandidateMemory['type'];
  content: string;
  subjectKey: string;
  predicateKey: string | null;
  objectValue: string | null;
  polarity: NonNullable<CandidateMemory['polarity']>;
  importanceScore: number;
  confidenceScore: number;
  evidence: string | null;
}

export function normalizeCandidate(c: CandidateMemory): NormalizedCandidate {
  return {
    type: c.type,
    content: c.content.trim(),
    // V1.0 单用户，主体固定
    subjectKey: c.subjectKey?.trim() || 'user',
    // 只有槽位与取值同时存在才有判定意义
    predicateKey: c.predicateKey ?? null,
    objectValue: c.objectValue?.trim() || null,
    polarity: c.polarity ?? 'affirm',
    importanceScore: c.importance ?? 0.5,
    confidenceScore: c.confidence ?? 1.0,
    evidence: c.evidence ?? null,
  };
}
