/**
 * Agent 的记忆工具（docs/02 §21）
 *
 * 【Q3 决策：只提供只读工具，不给写工具】
 *   docs/02 §21 列了六个工具：search / get / save / update / delete / get_timeline。
 *   但 Q3 已锁定「记忆写入路径**仅**后台抽取流水线；Agent 只读记忆，
 *   不持有写工具」。
 *
 *   因此本文件**只实现三个只读工具**：
 *     search_memory   语义检索
 *     get_memory      按 id 取一条
 *     get_timeline    查人生事件
 *
 *   save / update / delete **刻意不实现**。理由（Q3 的原始论证）：
 *     · 让模型写记忆 = 把「什么值得长期记住」的判断交给它临场决定，
 *       而那个判断不可复现、无法回归测试
 *     · 抽取流水线有幂等键、冲突判定、来源追踪、可评测；
 *       工具调用没有这些，会绕过全部保障
 *     · 一旦模型能写，它就可能把用户的某句话当成事实存下来，
 *       而用户从未确认过 —— 这与 PRD §3.4「用户拥有最终控制权」冲突
 *
 *   若将来确实需要「用户明确要求记住」这条路径，
 *   正确做法是抽取流水线识别这种意图，而不是给 Agent 写工具。
 *
 * 【这些工具与 HTTP 接口共享同一套 service】
 *   docs/04 §37 明确要求 Agent Tool 不走 HTTP、而是调 Application Service。
 *   因此这里直接调 retrieveMemories / findByIdIncludingInactive / getTimeline，
 *   与 /api/v1/memories 等端点用的是同一份逻辑 ——
 *   两处各写一遍必然漂移（例如软删除过滤条件）。
 */
import type { ToolDefinition, ToolContext } from '../agent/loop.js';
import { retrieveMemories } from './retriever.js';
import { findByIdIncludingInactive } from '../database/repository/memory-queries.js';
import { getTimeline } from '../timeline/timeline-service.js';
import type { Memory } from '../database/schema/memories.js';

/**
 * 工具输出的条数上限。
 *
 * ⚠️ 必须限制：工具结果会被塞进上下文，而 Agent Loop 的
 *    MAX_TOOL_RESULT_CHARS（8000 字符）只是最后一道截断 ——
 *    等到那时已经浪费了 token。在这里就取少一点更省。
 */
const MAX_SEARCH_RESULTS = 5;
const MAX_TIMELINE_EVENTS = 20;

export interface MemoryToolDeps {
  /** 当前用户。V1.0 单用户，但仍显式传入而不是工具内部去查 */
  userId: string;
}

/**
 * 构造三个只读记忆工具。
 *
 * 工厂函数而不是导出一组常量：工具需要 userId，
 * 而 userId 在构造 ToolDefinition 时才知道。
 */
export function createMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  return [searchMemoryTool(deps), getMemoryTool(), getTimelineTool(deps)];
}

// ============================================================
// search_memory
// ============================================================

function searchMemoryTool(deps: MemoryToolDeps): ToolDefinition {
  return {
    name: 'search_memory',
    description:
      '搜索用户的长期记忆。当用户问起过去说过的事、他的偏好、目标、经历时使用。' +
      '注意：对话上下文里已经自动包含了一部分相关记忆，' +
      '因此只在需要更多信息、或不确定时才调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索词。用用户的表述或它的同义改写，不要只用一个关键词。',
        },
      },
      required: ['query'],
    },
    execute: async (args: unknown, _ctx: ToolContext) => {
      const query = readString(args, 'query');
      if (!query) return { error: 'query 不能为空' };

      const result = await retrieveMemories({
        userId: deps.userId,
        query,
        limit: MAX_SEARCH_RESULTS,
      });

      /**
       * ⚠️ 工具结果里**不带 id 与分数**。
       *
       * 理由：模型拿到 id 会倾向于在回答里引用它（「根据记忆 m_abc123」），
       * 那对用户毫无意义。分数同理 —— 它是内部排序信号，
       * 展示出来只会让模型去做「相关性解说」而不是回答问题。
       * 需要按 id 取详情的场景由 get_memory 承担（用户会显式给出 id）。
       */
      return {
        count: result.memories.length,
        memories: result.memories.map((m) => ({
          content: m.content,
          type: m.type,
          /** 事实生效时间。让模型能正确表述「你之前提到过」而不是「你刚才说」 */
          valid_from: m.validFrom ? m.validFrom.toISOString().slice(0, 10) : null,
        })),
        /**
         * 把降级信息告诉模型。
         *
         * 这不是给它看的调试信息，而是**影响它如何回答**的事实：
         * 向量通道挂了意味着这次检索只做了字面匹配，
         * 结果可能不完整 —— 模型应当据此说「我这边没找到」而不是
         * 「你没有提过」。
         */
        ...(result.diagnostics.degradations.length > 0
          ? { note: '本次检索有降级，结果可能不完整' }
          : {}),
      };
    },
  };
}

// ============================================================
// get_memory
// ============================================================

function getMemoryTool(): ToolDefinition {
  return {
    name: 'get_memory',
    description:
      '按 id 获取一条长期记忆的完整信息（含来源与有效期）。' +
      'id 通常来自用户直接给出的标识，或界面上显示的条目。',
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆的 UUID' },
      },
      required: ['memory_id'],
    },
    execute: async (args: unknown, _ctx: ToolContext) => {
      const id = readString(args, 'memory_id');
      if (!id) return { error: 'memory_id 不能为空' };

      /**
       * 用 findByIdIncludingInactive（含 conflict / archived / superseded，
       * 但**排除已删除**）：
       *   模型可能需要解释「这条为什么不再生效了」（被替代/待裁决），
       *   但已删除的记忆不该被读出来 —— 那违反用户的删除意图（§29.1）。
       */
      const memory = await findByIdIncludingInactive(id);
      if (!memory) {
        return {
          error: '找不到这条记忆，或者它已被删除',
          hint: '不要向用户断言这条记忆不存在，只说「我这边查不到」。',
        };
      }

      return toMemoryDetail(memory);
    },
  };
}

/**
 * 记忆详情的工具输出形状。
 *
 * ⚠️ 带上 status 的解释而不是原样给枚举值：
 *    模型看到 `status: 'superseded'` 未必知道该怎么向用户表述。
 *    给一句人话（status_hint）能显著减少「它说的话很奇怪」的情况。
 */
function toMemoryDetail(m: Memory) {
  return {
    content: m.content,
    type: m.type,
    status: m.status,
    status_hint: STATUS_HINT[m.status] ?? m.status,
    subject_key: m.subjectKey,
    predicate_key: m.predicateKey,
    object_value: m.objectValue,
    valid_from: m.validFrom ? m.validFrom.toISOString().slice(0, 10) : null,
    valid_until: m.validUntil ? m.validUntil.toISOString().slice(0, 10) : null,
    importance: m.importanceScore,
    source_count: m.sourceCount,
  };
}

const STATUS_HINT: Record<string, string> = {
  active: '当前有效',
  conflict: '与其他记忆冲突，待用户确认，不参与召回',
  superseded: '已被更新的信息替代，只在回顾历史时使用',
  archived: '已归档，不参与召回',
  deleted: '已删除',
};

// ============================================================
// get_timeline
// ============================================================

function getTimelineTool(deps: MemoryToolDeps): ToolDefinition {
  return {
    name: 'get_timeline',
    description:
      '查询用户的人生事件时间线（换工作、搬家、开始做某事这类有明确时间点的经历）。' +
      '当用户问「我什么时候…」「之前发生过什么」时使用。',
    parameters: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: '起始日期，YYYY-MM-DD。可选，缺省不限',
        },
        end: {
          type: 'string',
          description: '结束日期，YYYY-MM-DD。可选，缺省为今天',
        },
        category: {
          type: 'string',
          enum: ['work', 'study', 'project', 'life', 'health', 'other'],
          description: '事件分类。可选',
        },
      },
    },
    execute: async (args: unknown, _ctx: ToolContext) => {
      const start = readString(args, 'start');
      const end = readString(args, 'end');
      const category = readString(args, 'category');

      const from = start ? parseDateBoundary(start, 'start') : undefined;
      const to = end ? parseDateBoundary(end, 'end') : undefined;

      /**
       * 直接复用 getTimeline（与 /api/v1/timeline 同一套逻辑）。
       *
       * ⚠️ 这里**不做分页**：工具调用没有「下一页」的概念，
       *    一次给不全就是给不全。因此用一个大 limit 取够，
       *    再由 MAX_TIMELINE_EVENTS 截断 —— 宁可少给，
       *    也不要让模型以为「时间线只有这些」。
       */
      const result = await getTimeline({
        userId: deps.userId,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(category !== undefined
          ? { category: category as 'work' | 'study' | 'project' | 'life' | 'health' | 'other' }
          : {}),
        limit: MAX_TIMELINE_EVENTS,
      });

      const events = result.months
        .flatMap((m) => m.events)
        .slice(0, MAX_TIMELINE_EVENTS)
        .map((e) => ({
          title: e.title,
          description: e.description,
          event_time: e.eventTime.toISOString().slice(0, 10),
          category: e.category,
        }));

      return {
        totalInRange: result.total,
        returned: events.length,
        events,
        /**
         * 明确告知是否被截断。
         *
         * 不告诉的话，模型会把「我看到的 20 条」当成全部，
         * 回答「你这段时间只做了这些事」—— 那是错的。
         */
        ...(result.total > events.length
          ? {
              truncated: true,
              note: `时间线共 ${result.total} 条，只展示了最近 ${events.length} 条。若用户问的是更早的事，请用 start 参数缩小范围。`,
            }
          : {}),
      };
    },
  };
}

// ============================================================
// 内部
// ============================================================

/**
 * 从工具参数里读字符串。
 *
 * 模型给的参数类型不可信（可能给数字、对象）。
 * 不做严格校验并抛错 —— 那会中断整个 Agent 循环；
 * 返回 undefined 让工具给出可读的错误结果，模型能自行修正。
 */
function readString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 解析日期参数的边界。
 *
 * 与 timeline 路由的同名函数保持一致（start 含当天 00:00，
 * end 含当天 23:59:59.999）—— 两处不一致会导致
 * 「模型查 12 月 31 日」与「用户在界面上查 12 月 31 日」得到不同结果。
 */
function parseDateBoundary(value: string, kind: 'start' | 'end'): Date | undefined {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly ? new Date(`${value}T00:00:00Z`) : new Date(value);

  if (Number.isNaN(parsed.getTime())) return undefined;
  return kind === 'start' ? parsed : new Date(parsed.getTime() + 86400_000 - 1);
}
