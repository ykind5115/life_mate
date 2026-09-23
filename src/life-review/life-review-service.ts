/**
 * Life Review 服务（docs/01 §7.6、docs/02 §27、docs/04 §31–§33）
 *
 * 【做什么】
 *   对一段时间做回顾：这段时间发生了什么、目标推进得如何、值得记住的是什么。
 *   数据来源（docs/04 §32 的流程图）：
 *     Timeline（events） + Memories + Goals + Conversation Summaries
 *   四条来源里目前只有前两条有数据：
 *     · Goals        —— goals 表零写入路径（与 events 曾经的问题相同，尚未解决）
 *     · Summaries    —— 会话摘要未实现（docs/02 §24）
 *   因此本实现**只用 events + memories**，并把缺失的来源显式记进
 *   `sourcesAvailable`，而不是假装聚合了四条。
 *   静默少用两条来源会让"这次回顾怎么这么空"无法解释。
 *
 * 【与 Timeline 的区别】
 *   Timeline 是**原始数据的有序呈现**（按时间列出发生了什么）。
 *   Life Review 是**一次 LLM 归纳**：把一堆事件读成一个有主线的叙述。
 *   因此前者不调用 LLM，后者必须调用 —— 也因此后者要防幻觉。
 *
 * 【防幻觉是本模块最重要的约束】
 *   回顾最容易出的问题是模型"编一段人生"：
 *   补充用户没说过的细节、把两件无关的事连成因果、
 *   用鼓励性语言掩盖"这段时间没有记录"。
 *   对策（见 REVIEW_SYSTEM_PROMPT）：
 *     ① 只依据给定材料，明确禁止补充材料外的信息
 *     ② 允许说"这段时间记录很少"，而不是凑内容
 *     ③ 要求区分「材料里写了」与「你的归纳」
 */
import type { LLMProvider } from '../llm/provider.js';
import { listEventsChronological } from '../database/repository/event-store.js';
import { findValidAt } from '../database/repository/memory-queries.js';
import { listGoals } from '../database/repository/goal-store.js';
import type { Event } from '../database/schema/events.js';
import type { Memory } from '../database/schema/memories.js';
import type { Goal } from '../database/schema/goals.js';

const REVIEW_SYSTEM_PROMPT = `你是 LifeMate，正在帮用户回顾一段时间的生活。

你会收到这段时间内的**原始记录**：事件与长期记忆。你的任务是把它们整理成一段易读的回顾。

## 必须遵守

1. **只依据给定材料**。不要补充材料里没有的信息 ——
   不要推测用户没说过的心情、动机、人际关系，也不要编造细节。
2. 材料少就如实说少。例如「这段时间记录不多，只有两次对话」。
   **不允许**为了显得丰富而凑内容或拔高意义。
3. 区分事实与归纳：
   - 事实：「8 月你换了工作」
   - 归纳：「这几个月的主线是职业上的调整」
   归纳要有依据，且用词上让用户看得出这是你的看法。
4. 不要做心理诊断，不要评价用户的选择好不好。
5. 不要用空洞的鼓励收尾（「继续加油！」这类）。
6. 用中文，简洁。不要复述材料里的每一条，要**提炼**。

## 输出格式

只输出 JSON，不要任何解释文字，不要 markdown 代码块：

{
  "summary": "一段话（100~250 字）概括这段时间的主线",
  "highlights": [
    { "text": "值得单独提出的一件事", "eventId": "对应事件的 id，没有就给 null" }
  ],
  "themes": ["这段时间反复出现的主题，如「职业调整」「学习」"]
}

highlights 最多 5 条。若这段时间确实没什么值得提的，给空数组。`;

export interface LifeReviewInput {
  userId: string;
  from: Date;
  to: Date;
  /** 覆盖 LLM Provider（测试注入用） */
  provider?: LLMProvider;
  /** 单次回顾最多纳入多少条事件（防止一次塞入过长材料） */
  maxEvents?: number;
  /** 单次回顾最多纳入多少条记忆 */
  maxMemories?: number;
}

/** 模型产出的回顾正文 */
export interface ReviewContent {
  summary: string;
  highlights: { text: string; eventId: string | null }[];
  themes: string[];
}

export interface LifeReviewResult {
  period: { from: Date; to: Date };
  review: ReviewContent;
  /** 供前端展示原始材料，也让用户能核对"它是不是照着我说的写的" */
  events: Event[];
  memories: Memory[];
  /** 这段时间内活跃的目标（docs/04 §32 的四条来源之一） */
  goals: Goal[];
  /**
   * 实际用到的数据来源与条数。
   *
   * ⚠️ 显式列出而不是省略：docs/04 §32 画了四条来源
   *    （Timeline / Memories / Goals / Summaries），
   *    当前只接入了三条 —— 摘要还没接进回顾。
   *    不说清楚的话「回顾怎么没提我之前的对话」会被当成 bug 排查很久。
   */
  sourcesAvailable: {
    events: number;
    memories: number;
    goals: number;
    /** 未接入的来源及原因 */
    unavailable: { source: 'summaries'; reason: string }[];
  };
}

/**
 * 生成生活回顾。
 *
 * 材料为空的处理：**不调用 LLM**，直接返回一段说明性的空回顾。
 * 理由：没有材料时调用模型，它只能编 —— 那不是我们想要的输出。
 * 少一次调用 + 不产生幻觉，两个好处。
 */
export async function generateLifeReview(
  input: LifeReviewInput
): Promise<LifeReviewResult> {
  const events = await listEventsChronological({
    userId: input.userId,
    from: input.from,
    to: input.to,
    limit: input.maxEvents ?? 100,
  });

  const memories = await loadMemoriesForPeriod(input);
  const goals = await loadGoalsForPeriod(input);

  const unavailable: LifeReviewResult['sourcesAvailable']['unavailable'] = [
    {
      source: 'summaries',
      reason:
        '会话摘要已生成并用于对话上下文，但尚未接入 Life Review 的材料' +
        '（docs/04 §32 把它列为来源之一，接它需要按区间关联会话，尚未实现）',
    },
  ];

  if (events.length === 0 && memories.length === 0 && goals.length === 0) {
    return {
      period: { from: input.from, to: input.to },
      review: {
        summary: '这段时间没有任何记录。可能是没有聊过，或者聊的内容没有被判定为值得长期保留。',
        highlights: [],
        themes: [],
      },
      events,
      memories,
      goals,
      sourcesAvailable: { events: 0, memories: 0, goals: 0, unavailable },
    };
  }

  const provider = input.provider ?? (await defaultProvider());

  const res = await provider.generate({
    messages: [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildReviewMaterials(input.from, input.to, events, memories, goals),
      },
    ],
    maxOutputTokens: 4096,
  });

  const review = parseReviewContent(res.content);

  return {
    period: { from: input.from, to: input.to },
    review,
    events,
    memories,
    goals,
    sourcesAvailable: {
      events: events.length,
      memories: memories.length,
      goals: goals.length,
      unavailable,
    },
  };
}

// ============================================================
// 材料组装
// ============================================================

/**
 * 拼装给模型看的材料。
 *
 * ⚠️ 事件带 id，记忆与目标不带 —— 因为 highlights 要能引用事件 id。
 *    给记忆/目标 id 没有用（回顾里不需要指向某条记忆或某个目标），
 *    反而会让模型倾向于输出 id 而挤占正文。
 *
 * ⚠️ 目标单独成段而不是混进记忆：目标是**仍在进行**的东西，
 *    与「发生过的事」在时态上不同。混在一起会让模型把
 *    「想学吉他」写成「学了吉他」。
 */
export function buildReviewMaterials(
  from: Date,
  to: Date,
  events: Event[],
  memories: Memory[],
  goals: Goal[] = []
): string {
  const range = `${formatDate(from)} 至 ${formatDate(to)}`;

  const eventLines =
    events.length > 0
      ? events
          .map(
            (e) =>
              `- [${formatDate(e.eventTime)}] (id=${e.id}) ${e.title}` +
              (e.description ? `：${e.description}` : '') +
              (e.category ? ` 〔${e.category}〕` : '')
          )
          .join('\n')
      : '（无）';

  const memoryLines =
    memories.length > 0
      ? memories.map((m) => `- [${m.type}] ${m.content}`).join('\n')
      : '（无）';

  const goalLines =
    goals.length > 0
      ? goals
          .map(
            (g) =>
              `- ${g.title}（${goalStatusText(g.status)}` +
              (g.targetAt ? `，目标时间 ${formatDate(g.targetAt)}` : '') +
              '）' +
              (g.description ? `：${g.description}` : '')
          )
          .join('\n')
      : '（无）';

  return [
    `回顾区间：${range}`,
    '',
    '## 这段时间发生的事件（按时间正序）',
    eventLines,
    '',
    '## 这段时间有效的长期记忆',
    memoryLines,
    '',
    '## 用户当前的目标（仍在进行中，不是已经完成的事）',
    goalLines,
    '',
    '请按契约输出 JSON。',
  ].join('\n');
}

function goalStatusText(status: string): string {
  const map: Record<string, string> = {
    active: '进行中',
    paused: '已搁置',
    completed: '已完成',
    cancelled: '已放弃',
    archived: '已归档',
  };
  return map[status] ?? status;
}

/**
 * 取该区间内"成立过"的记忆。
 *
 * 【为什么用 findValidAt（历史谓词）而不是 listCurrent】
 *   回顾一段过去时，要看到**当时成立**的事实 ——
 *   包括现在已被替代的那些。例如回顾 6 月时，
 *   「用户当时住在广州」（现已被「搬到深圳」替代）恰恰是关键信息。
 *   用 listCurrent 会把它过滤掉，回顾就丢掉了变化的脉络。
 */
async function loadMemoriesForPeriod(input: LifeReviewInput): Promise<Memory[]> {
  const all = await findValidAt({ userId: input.userId, at: input.to });
  return all.slice(0, input.maxMemories ?? 50);
}

/**
 * 取该区间内活跃的目标。
 *
 * 【为什么按「创建时间 ≤ 区间终点」筛，而不是要求它在这段时间内创建】
 *   回顾的目的是「这段时间我的生活是什么样」——
 *   一个三个月前立下、至今仍在推进的目标，**属于**这段回顾。
 *   只取「在这段时间内新建的」会漏掉持续进行中的主线。
 *
 * 【为什么排除已终结的状态】
 *   completed / cancelled / archived 的目标属于「已经结束的事」，
 *   它们在这段时间里没有"进行"的部分，列进去会让回顾显得杂乱。
 *   若用户想回顾「我完成过哪些目标」，那是另一个视角（按 completed_at 查）。
 */
async function loadGoalsForPeriod(input: LifeReviewInput): Promise<Goal[]> {
  const page = await listGoals({
    userId: input.userId,
    status: ['active', 'paused'],
    limit: 30,
  });

  return page.items.filter((g) => g.createdAt.getTime() <= input.to.getTime());
}

// ============================================================
// 解析
// ============================================================

/**
 * 解析回顾输出。
 *
 * 容错：模型可能包代码块、加解释。
 * 但**缺失 summary 时报错**而不是返回空串 ——
 * 一段没有 summary 的回顾对用户毫无价值，静默返回会让前端显示一片空白，
 * 看起来像系统坏了。宁可显式失败。
 */
export function parseReviewContent(raw: string): ReviewContent {
  let text = raw.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) {
    throw new Error(`回顾输出里找不到 JSON：${raw.slice(0, 200)}`);
  }

  const obj = JSON.parse(text.slice(first, last + 1)) as Partial<ReviewContent>;

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (summary.length === 0) {
    throw new Error('回顾输出缺少 summary');
  }

  /**
   * highlights 的容错解析。
   *
   * 模型可能给字符串数组、漏掉 eventId、或给出多余的字段 ——
   * 这里逐项筛而不是直接信任，筛不出来的丢弃（一条 highlight 不值当整批失败）。
   */
  const highlights: ReviewContent['highlights'] = [];
  if (Array.isArray(obj.highlights)) {
    for (const h of obj.highlights.slice(0, 5)) {
      if (typeof h !== 'object' || h === null) continue;
      const text = (h as { text?: unknown }).text;
      if (typeof text !== 'string' || text.trim().length === 0) continue;

      const eventId = (h as { eventId?: unknown }).eventId;
      highlights.push({
        text: text.trim(),
        eventId: typeof eventId === 'string' && eventId.length > 0 ? eventId : null,
      });
    }
  }

  const themes = Array.isArray(obj.themes)
    ? obj.themes.filter((t): t is string => typeof t === 'string').slice(0, 8)
    : [];

  return { summary, highlights, themes };
}

// ============================================================
// 内部
// ============================================================

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 延迟导入以避免在不需要 LLM 的路径上加载 env 校验 */
async function defaultProvider(): Promise<LLMProvider> {
  const mod = await import('../llm/index.js');
  return mod.getLLMProvider();
}
