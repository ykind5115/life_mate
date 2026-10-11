/**
 * relationships 数据访问（docs/03 §22）
 *
 * 【这一层为什么现在才补】
 *   表从 Phase 3 就建好了，但一直没有 Repository / Service / API ——
 *   AGENTS.md 把它列为未完成项。前端改版要展示人际关系，
 *   因此补上「表 → 仓储 → 接口 → 界面」这条完整链路。
 *
 * 【与记忆的连接方式（§22.3 的明确设计）】
 *   记忆里的「某人」通过
 *     predicate_key = 'relationship.person' AND object_value = 人名
 *   关联到本表，**不是外键硬绑定**。
 *   理由：关系记录尚不存在时记忆也必须能写成功 ——
 *   关系是事后逐步补全的，不该成为记忆写入的前置条件。
 *
 *   因此本文件提供 `findMemoriesByPersonNames()`：
 *   按**人名**反查记忆，而不是按 id。这是 §22.3 那条设计的直接后果，
 *   不是偷懒 —— 用 id 关联会要求先有关系记录才能写记忆。
 *
 * 【日志纪律】§29.1 禁止记录 relationship.name ——
 *   人名是私密信息。本文件不产生日志。
 */
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { db } from '../client.js';
import { relationships, type Relationship } from '../schema/relationships.js';
import { memories } from '../schema/memories.js';
import { RELATIONSHIP_STATUSES, type RelationshipStatus } from '../schema/enums.js';
import type { ExecutorOption, Paginated } from './types.js';

/** 未删除的条件。软删除的语义与记忆一致：误删可恢复 */
function aliveCondition(): SQL {
  return isNull(relationships.deletedAt);
}

export interface ListRelationshipsFilter {
  userId: string;
  status?: RelationshipStatus;
  /** 按人名模糊匹配（ILIKE），用于搜索框 */
  nameQuery?: string;
  limit?: number;
  offset?: number;
}

/** 列出人际关系 */
export async function listRelationships(
  filter: ListRelationshipsFilter,
  options: ExecutorOption = {}
): Promise<Paginated<Relationship>> {
  const exec = options.executor ?? db;

  const conds: (SQL | undefined)[] = [eq(relationships.userId, filter.userId), aliveCondition()];
  if (filter.status) conds.push(eq(relationships.status, filter.status));
  if (filter.nameQuery && filter.nameQuery.trim().length > 0) {
    /**
     * ILIKE + 转义：人名里可能有 % 或 _，不转义会把它们当通配符。
     * 用参数绑定而不是拼字符串 —— 这是查询条件，不是可白名单化的枚举。
     */
    const escaped = filter.nameQuery.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(sql`${relationships.name} ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }

  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  const [items, totals] = await Promise.all([
    exec
      .select()
      .from(relationships)
      .where(and(...conds))
      // 活跃的排前面，其次按更新时间的倒序（最近聊到的人更可能被找）
      .orderBy(
        sql`CASE WHEN ${relationships.status} = 'active' THEN 0 ELSE 1 END`,
        desc(relationships.updatedAt)
      )
      .limit(limit)
      .offset(offset),
    exec.select({ n: count() }).from(relationships).where(and(...conds)),
  ]);

  return { items, total: totals[0]?.n ?? 0, limit, offset };
}

/** 按 id 取（含已删除，调用方自行判断 —— 与 findConversationById 同一口径） */
export async function findRelationshipById(
  id: string,
  options: ExecutorOption = {}
): Promise<Relationship | undefined> {
  const exec = options.executor ?? db;
  const rows = await exec.select().from(relationships).where(eq(relationships.id, id)).limit(1);
  return rows[0];
}

/** 按人名精确取一条未删除的（唯一索引保证最多一条） */
export async function findRelationshipByName(
  params: { userId: string; name: string },
  options: ExecutorOption = {}
): Promise<Relationship | undefined> {
  const exec = options.executor ?? db;
  const rows = await exec
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.userId, params.userId),
        eq(relationships.name, params.name),
        aliveCondition()
      )
    )
    .limit(1);
  return rows[0];
}

export interface CreateRelationshipInput {
  userId: string;
  name: string;
  relationType?: string | null;
  description?: string | null;
  status?: RelationshipStatus;
}

/**
 * 新建。
 *
 * ⚠️ 撞 `uq_relationships_user_name` 时**不在这里吞掉** ——
 *    让唯一约束的错误抛上去，路由层转成 409。
 *    在这里「查一下有没有再插」是竞态写法（AGENTS.md §4 记过同类教训），
 *    唯一索引才是真保证。
 */
export async function createRelationship(
  input: CreateRelationshipInput,
  options: ExecutorOption = {}
): Promise<Relationship> {
  const exec = options.executor ?? db;

  const rows = await exec
    .insert(relationships)
    .values({
      userId: input.userId,
      name: input.name,
      relationType: input.relationType ?? null,
      description: input.description ?? null,
      status: input.status ?? 'active',
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('插入关系后未返回记录');
  return row;
}

export interface UpdateRelationshipInput {
  name?: string;
  relationType?: string | null;
  description?: string | null;
  status?: RelationshipStatus;
}

/** 更新（PATCH 语义：只改显式传入的字段） */
export async function updateRelationship(
  id: string,
  input: UpdateRelationshipInput,
  options: ExecutorOption = {}
): Promise<Relationship | undefined> {
  const exec = options.executor ?? db;

  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.name !== undefined) patch['name'] = input.name;
  if (input.relationType !== undefined) patch['relationType'] = input.relationType;
  if (input.description !== undefined) patch['description'] = input.description;
  if (input.status !== undefined) patch['status'] = input.status;

  const rows = await exec
    .update(relationships)
    .set(patch)
    .where(and(eq(relationships.id, id), aliveCondition()))
    .returning();

  return rows[0];
}

/** 软删除 */
export async function softDeleteRelationship(
  id: string,
  options: ExecutorOption = {}
): Promise<Relationship | undefined> {
  const exec = options.executor ?? db;
  const rows = await exec
    .update(relationships)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(relationships.id, id), aliveCondition()))
    .returning();
  return rows[0];
}

/**
 * 恢复被软删除的。
 *
 * 不需要额外条件：软删除只置 deleted_at，status 不变
 * （与记忆不同 —— 记忆的删除要动 status，关系没有 'deleted' 这个状态）。
 */
export async function restoreRelationship(
  id: string,
  options: ExecutorOption = {}
): Promise<Relationship | undefined> {
  const exec = options.executor ?? db;
  const rows = await exec
    .update(relationships)
    .set({ deletedAt: null, updatedAt: sql`now()` })
    .where(eq(relationships.id, id))
    .returning();
  return rows[0];
}

// ============================================================
// 与记忆的关联（§22.3：按人名，不按外键）
// ============================================================

/** 某个人名下的记忆分组 */
export interface PersonMemories {
  name: string;
  memories: {
    id: string;
    content: string;
    type: string;
    status: string;
    validFrom: Date | null;
  }[];
}

/**
 * 按一组人名反查记忆。
 *
 * 【为什么用 IN 而不是每个人一次查询】
 *   知识图谱要给每个「人」节点挂上它相关的记忆。
 *   10 个人就是 10 次查询 —— 一次批量查完在内存里分组。
 *
 * 【为什么只取这几个字段】
 *   图谱只需要「有多少条、大概讲什么」。整行取回来会带上
 *   embedding 状态、槽位等用不上的东西，也更容易不小心把
 *   正文带进日志（§29.1）。
 */
export async function findMemoriesByPersonNames(
  params: { userId: string; names: string[]; perPersonLimit?: number },
  options: ExecutorOption = {}
): Promise<PersonMemories[]> {
  const exec = options.executor ?? db;

  const names = params.names.filter((n) => n.trim().length > 0);
  if (names.length === 0) return [];

  const rows = await exec
    .select({
      id: memories.id,
      content: memories.content,
      type: memories.type,
      status: memories.status,
      validFrom: memories.validFrom,
      objectValue: memories.objectValue,
    })
    .from(memories)
    .where(
      and(
        eq(memories.userId, params.userId),
        isNull(memories.deletedAt),
        /**
         * 只认 §22.3 约定的那个槽位。
         * 用 objectValue IN (...) 而不是 content LIKE —— 后者会把
         * 「我同事说他女朋友……」这种顺带提到也算成这个人的记忆。
         */
        eq(memories.predicateKey, 'relationship.person'),
        inArray(memories.objectValue, names)
      )
    )
    .orderBy(asc(memories.objectValue), desc(memories.validFrom));

  const perPerson = params.perPersonLimit ?? 20;
  const grouped = new Map<string, PersonMemories['memories']>();

  for (const r of rows) {
    const key = r.objectValue ?? '';
    const bucket = grouped.get(key) ?? [];
    if (bucket.length < perPerson) {
      bucket.push({
        id: r.id,
        content: r.content,
        type: r.type,
        status: r.status,
        validFrom: r.validFrom,
      });
    }
    grouped.set(key, bucket);
  }

  return names.map((name) => ({ name, memories: grouped.get(name) ?? [] }));
}

/** 关系状态分布（观测用，不含人名） */
export async function countRelationshipsByStatus(
  userId: string,
  options: ExecutorOption = {}
): Promise<{ status: string; n: number }[]> {
  const exec = options.executor ?? db;
  const rows = await exec
    .select({ status: relationships.status, n: count() })
    .from(relationships)
    .where(and(eq(relationships.userId, userId), aliveCondition()))
    .groupBy(relationships.status);
  return rows.map((r) => ({ status: r.status, n: Number(r.n) }));
}

export { RELATIONSHIP_STATUSES };
