/**
 * 知识图谱数据组装（docs/16 §3.3）
 *
 * 【这个图谱画的是什么 —— 这一点必须先说清楚】
 *
 *   用户要「知识图谱」，但他库里的真实情况是：
 *     记忆 90 条、人际关系 0 条、目标 0 条、事件 11 条
 *
 *   如果照着「图数据库」的直觉去做（万事万物都是节点、靠实体关系连边），
 *   画出来会是一堆**没有边的孤点** —— 看起来像系统坏了。
 *
 *   所以这里的做法是：**以用户为圆心的一跳图**。
 *
 *              事件(work)        人（女友）
 *                   \              /
 *                    \            /
 *   记忆(偏好) ──────  用户  ────── 人（领导）
 *                    /            \
 *                   /              \
 *              目标(进行中)      事件(life)
 *
 *   每一类节点都由**库里真实存在的数据**产生，边连到用户。
 *   没有数据的那一类就自然不出现 —— 而不是画一个空壳。
 *
 * 【为什么不做「记忆 → 记忆」的相似度边】
 *   那需要两两算向量相似度（90 条 = 4005 次比较），而且
 *   「语义相似」不等于「有关系」—— 画出来会是一团毛线球，
 *   用户看不出任何东西。等有真实的实体关系数据再说。
 *
 * 【为什么人节点的记忆按人名反查而不是按外键】
 *   §22.3 的明确设计：记忆里的「某人」通过
 *   predicate_key='relationship.person' + object_value=人名 关联，
 *   不是外键。理由见 relationship-store.ts 的文件头。
 *
 * 【日志纪律】本文件不产生日志。人名、记忆正文都不进日志（§29.1）。
 */
import {
  findMemoriesByPersonNames,
  listEvents,
  listGoals,
  listPersonNames,
  listRelationships,
  getMemoryOverview,
} from '../database/repository/index.js';
import type { ExecutorOption } from '../database/repository/types.js';

/** 图谱节点。id 在同类内唯一，前拼类型前缀避免跨类撞号 */
export interface GraphNode {
  id: string;
  /** user | person | event | goal | memory-type */
  kind: 'user' | 'person' | 'event' | 'goal' | 'memory_group';
  label: string;
  /** 节点显示的大小权重（0~1），前端映射成半径 */
  weight: number;
  /** 附加说明，hover 时显示 */
  detail?: string;
  /** 分类（事件/记忆分组用），前端据此上色 */
  category?: string;
  /** 数字徽标，如「12 条记忆」 */
  count?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** 边的语义，前端据此决定线型与标签 */
  kind: 'has_person' | 'experienced' | 'pursuing' | 'knows_about';
  label?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * 统计。前端要显示「这个图谱包含什么」——
   * 否则用户看到一个只有几个点的图，会以为数据丢了。
   */
  stats: {
    people: number;
    events: number;
    goals: number;
    memoryGroups: number;
    memories: number;
  };
}

const USER_NODE_ID = 'user:self';

/**
 * 组装图谱。
 *
 * 上限刻意保守：节点太多时前端力导向布局会糊成一团，
 * 而且圈层太多反而看不出结构。
 */
export async function buildKnowledgeGraph(
  params: { userId: string; userName: string; maxPerKind?: number },
  options: ExecutorOption = {}
): Promise<GraphData> {
  const maxPerKind = params.maxPerKind ?? 12;

  /**
   * 五类数据并行取。
   * 人节点要先拿到人名列表，才能去反查记忆 —— 因此分两段。
   */
  const [relationships, events, goals, overview, personNames] = await Promise.all([
    listRelationships({ userId: params.userId, limit: maxPerKind }, options),
    listEvents({ userId: params.userId, timelineOnly: true, limit: maxPerKind }, options),
    listGoals({ userId: params.userId, limit: maxPerKind }, options),
    getMemoryOverview(params.userId, options),
    /**
     * ⚠️ 人节点**从记忆里派生**，而不是只读 relationships 表。
     *
     *   原因（2026-10-08 实测）：relationships 是 0 行，
     *   而记忆里有 2 个带 relationship.person 槽位的人名。
     *   只读关系表的话，图谱上一个人都没有 —— 而用户明明聊过这些人。
     *
     *   §22.3 的设计本来就是「记忆用槽位指向人名，不建外键」，
     *   所以「库里有哪些人」这件事**只有记忆知道**。
     *   关系表是用户手动补全的信息（关系类型、描述），是增强而非前提。
     */
    listPersonNames(params.userId, maxPerKind, options),
  ]);

  const personNodes = mergePeople(relationships.items, personNames, maxPerKind);

  const eventNodes: GraphNode[] = events.items.map((e) => ({
    id: `event:${e.id}`,
    kind: 'event',
    label: e.title,
    // 重要度直接用 —— 它本来就是为此设计的
    weight: 0.3 + e.importanceScore * 0.7,
    ...(e.category ? { category: e.category } : {}),
    detail: formatEventDate(e.eventTime, e.eventPrecision),
  }));

  const goalNodes: GraphNode[] = goals.items.map((g) => ({
    id: `goal:${g.id}`,
    kind: 'goal',
    label: g.title,
    weight: 0.4 + g.priority * 0.6,
    category: g.status,
    detail: goalStatusLabel(g.status),
  }));

  /**
   * 人 → 记忆：把人名拿去反查带 relationship.person 槽位的记忆。
   * 这是图谱里信息量最大的一层 —— 它让「人」这个节点不只是一个名字。
   */
  const personMemories = await findMemoriesByPersonNames(
    { userId: params.userId, names: personNodes.map((n) => n.label) },
    options
  );

  const memoryByPerson = new Map(personMemories.map((p) => [p.name, p.memories]));
  for (const node of personNodes) {
    const n = memoryByPerson.get(node.label)?.length ?? 0;
    if (n > 0) {
      node.count = n;
      node.weight = Math.min(1, node.weight + 0.1);
    }
  }

  /**
   * 记忆分组节点：只给「有名字可归」的那些人。
   *
   * ⚠️ 刻意**不**做「按 type 分组」（fact/preference/...）。
   *    那画出来是四个悬空的方块，与用户的生活没有关系 ——
   *    图谱的价值在于「谁 / 什么事」之间的联系，不在于统计分类。
   *    分类统计在「记忆」页的概览里已经有了，重复一遍没意义。
   */
  const memoryGroups: GraphNode[] = [];
  const memoryEdges: GraphEdge[] = [];
  for (const node of personNodes) {
    const memories = memoryByPerson.get(node.label) ?? [];
    if (memories.length === 0) continue;

    const groupId = `memory_group:person:${node.label}`;
    const first = memories[0];
    memoryGroups.push({
      id: groupId,
      kind: 'memory_group',
      label: `${node.label} · 相关记忆`,
      weight: Math.min(1, 0.35 + memories.length * 0.05),
      count: memories.length,
      // 条件式展开：exactOptionalPropertyTypes 下不能显式传 undefined
      ...(first ? { detail: first.content.slice(0, 40) } : {}),
    });
    memoryEdges.push({ source: node.id, target: groupId, kind: 'knows_about' });
  }

  const nodes: GraphNode[] = [
    {
      id: USER_NODE_ID,
      kind: 'user',
      label: params.userName,
      weight: 1,
      count: overview.total,
      detail: `${overview.total} 条记忆`,
    },
    ...personNodes,
    ...eventNodes,
    ...goalNodes,
    ...memoryGroups,
  ];

  const edges: GraphEdge[] = [
    ...personNodes.map<GraphEdge>((n) => ({
      source: USER_NODE_ID,
      target: n.id,
      kind: 'has_person',
    })),
    ...eventNodes.map<GraphEdge>((n) => ({
      source: USER_NODE_ID,
      target: n.id,
      kind: 'experienced',
    })),
    ...goalNodes.map<GraphEdge>((n) => ({
      source: USER_NODE_ID,
      target: n.id,
      kind: 'pursuing',
    })),
    ...memoryEdges,
  ];

  return {
    nodes,
    edges,
    stats: {
      people: personNodes.length,
      events: eventNodes.length,
      goals: goalNodes.length,
      memoryGroups: memoryGroups.length,
      memories: overview.total,
    },
  };
}

/** 事件时间显示：day 精度只到日期，minute 精度带上时刻（见 C40） */
function formatEventDate(at: Date, precision: string): string {
  const iso = at.toISOString();
  return precision === 'minute' ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/**
 * 合并「手工录入的关系」与「从记忆派生的人名」。
 *
 * 【为什么要合并，而不是二选一】
 *   · 只用手工关系：relationships 是 0 行 → 图谱上一个人都没有，
 *     而用户明明在记忆里提过「女朋友」「小换（前女友）」
 *   · 只用派生人名：丢掉了关系类型、描述、状态这些用户手动补的信息
 *
 *   实测数据（2026-10-08）：关系表 0 行、记忆里有 2 个人名。
 *   两者都取，手工的优先（信息更全）。
 *
 * 【id 的取法】
 *   有手工记录时用 `person:<关系id>`（稳定，前端可据此跳详情页）；
 *   纯派生的用 `person:derived:<人名>`。
 *   两者都在同一命名空间下，不会与 event/goal 撞号。
 */
function mergePeople(
  relations: { id: string; name: string; relationType: string | null; description: string | null; status: string }[],
  derivedNames: string[],
  maxPerKind: number
): GraphNode[] {
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();

  for (const r of relations) {
    const key = r.name.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({
      id: `person:${r.id}`,
      kind: 'person',
      label: r.name,
      /**
       * 权重按「有没有更多信息」给：只有名字的节点小一点，
       * 有描述或关系类型的更实 —— 这比按名字长度之类的无意义指标好。
       */
      weight: r.description || r.relationType ? 0.7 : 0.5,
      ...(r.relationType ? { category: r.relationType } : {}),
      ...(r.status !== 'active'
        ? { detail: r.status === 'ended' ? '关系已结束' : '已归档' }
        : {}),
    });
  }

  for (const name of derivedNames) {
    const key = name.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({
      id: `person:derived:${key}`,
      kind: 'person',
      label: name,
      weight: 0.45,
      // 标明来源：用户能看出「这个人我还没补过关系信息」
      detail: '来自记忆',
    });
  }

  return nodes.slice(0, maxPerKind);
}

const GOAL_STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '已搁置',
  completed: '已完成',
  cancelled: '已放弃',
  archived: '已归档',
};

function goalStatusLabel(status: string): string {
  return GOAL_STATUS_LABEL[status] ?? status;
}
