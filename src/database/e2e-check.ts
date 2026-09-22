/**
 * 端到端验证：写入记忆 → 生成向量 → 入库 → 语义检索
 *
 * 目的：确认 Node 应用 / TEI embedding 服务 / PostgreSQL+pgvector
 *       三者真正打通，而不只是各自能跑。
 *
 * 运行：pnpm e2e:check
 *
 * ⚠️ 全程在事务中，结尾 ROLLBACK，不留数据。
 *    但会真实调用 embedding 服务（本地 GPU，无费用）。
 */
import { sql } from 'drizzle-orm';

import { closePool, db } from './client.js';
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID, env } from '../shared/env.js';

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${env.EMBEDDING_BASE_URL}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: text }),
    signal: AbortSignal.timeout(env.EMBEDDING_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`embedding 服务返回 ${res.status}`);
  }

  const json = (await res.json()) as number[][];
  const vec = json[0];
  if (!vec) throw new Error('embedding 服务返回空数组');

  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `向量维度 ${vec.length} 与冻结值 ${EMBEDDING_DIM} 不一致。` +
        `Schema 用的是 VECTOR(${EMBEDDING_DIM})，必须一致（docs/03 §4.2）`
    );
  }
  return vec;
}

/** 按 docs/03 §14.5 的规则拼接 embedded_text */
function buildEmbeddedText(parts: {
  type: string;
  subject: string;
  content: string;
  timeHint?: string;
}): string {
  const seg = [parts.type, parts.subject, parts.content];
  if (parts.timeHint) seg.push(parts.timeHint);
  return seg.join('｜');
}

/** 把 number[] 转成 pgvector 字面量。用固定小数位避免超长字符串 */
function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(7)).join(',')}]`;
}

async function main(): Promise<void> {
  const log: string[] = [];
  const ok = (m: string) => log.push(`  [OK]   ${m}`);
  const fail = (m: string) => log.push(`  [FAIL] ${m}`);

  // 用真实表但全程回滚。为满足外键，先建一个临时用户
  await db.execute(sql`BEGIN`);

  try {
    const userId = '00000000-0000-0000-0000-0000000000aa';
    await db.execute(
      sql`INSERT INTO users (id, name) VALUES (${userId}, 'e2e-test')`
    );

    // ---------- 1. 写入三条记忆并生成向量 ----------
    const seeds = [
      { type: 'fact', content: '用户正在学习 TypeScript' },
      { type: 'fact', content: '用户住在广州' },
      { type: 'fact', content: '用户喜欢直接、具体的技术解释' },
    ];

    const memoryIds: string[] = [];
    for (const s of seeds) {
      const embeddedText = buildEmbeddedText({
        type: s.type,
        subject: '用户',
        content: s.content,
      });
      const vec = await embed(embeddedText);
      const hash = await sha256Hex(embeddedText);

      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO memories (user_id, type, content, status)
        VALUES (${userId}, ${s.type}, ${s.content}, 'active')
        RETURNING id
      `);
      const memId = r.rows[0]!.id;
      memoryIds.push(memId);

      await db.execute(sql`
        INSERT INTO memory_embeddings
          (memory_id, model, dim, embedded_text, content_hash, embedding, status)
        VALUES (
          ${memId}, ${EMBEDDING_MODEL_ID}, ${EMBEDDING_DIM},
          ${embeddedText}, ${hash}, ${toVectorLiteral(vec)}::vector, 'ready'
        )
      `);
    }
    ok(`写入 ${seeds.length} 条记忆及其向量`);

    // ---------- 2. 语义检索：查询不含关键词，看能否召回 ----------
    const query = '我最近那个 TS 项目怎么样了';
    const qvec = await embed(buildEmbeddedText({ type: 'fact', subject: '用户', content: query }));

    const hits = await db.execute<{ content: string; sim: number }>(sql`
      SELECT m.content,
             (1 - (e.embedding <=> ${toVectorLiteral(qvec)}::vector))::float8 AS sim
        FROM memories m
        JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE m.user_id = ${userId}
         AND m.status = 'active'
         AND m.deleted_at IS NULL
         AND m.valid_until IS NULL
         AND m.superseded_by IS NULL
         AND e.status = 'ready'
         AND e.model = ${EMBEDDING_MODEL_ID}
       ORDER BY e.embedding <=> ${toVectorLiteral(qvec)}::vector
       LIMIT 3
    `);

    const top = hits.rows[0];
    if (top?.content === '用户正在学习 TypeScript') {
      ok(`语义检索命中正确（查询「TS 项目」→ 召回「TypeScript」，相似度 ${top.sim.toFixed(4)}）`);
    } else {
      fail(`语义检索未命中预期，实际首位：${top?.content ?? '(无结果)'}`);
    }

    // ---------- 3. 软删除必须从检索中消失（§18.3）----------
    await db.execute(sql`
      UPDATE memories SET status='deleted', deleted_at=now()
       WHERE id = ${memoryIds[0]!}
    `);
    const afterDelete = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM memories m
        JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE m.user_id = ${userId}
         AND m.status = 'active' AND m.deleted_at IS NULL
         AND m.valid_until IS NULL AND m.superseded_by IS NULL
         AND e.status = 'ready'
    `);
    if (afterDelete.rows[0]?.n === 2) {
      ok('软删除后该记忆已从召回路径消失');
    } else {
      fail(`软删除后仍有 ${String(afterDelete.rows[0]?.n)} 条可召回（期望 2）`);
    }

    // ---------- 4. 不可变事实：supersede 而非就地更新（Q1）----------
    const oldId = memoryIds[1]!;
    const supersedeText = buildEmbeddedText({
      type: 'fact',
      subject: '用户',
      content: '用户已搬到深圳',
      timeHint: `${new Date().toISOString().slice(0, 10)} 起有效`,
    });
    const newVec = await embed(supersedeText);

    const rNew = await db.execute<{ id: string }>(sql`
      INSERT INTO memories (user_id, type, content, subject_key, predicate_key, object_value, status, valid_from)
      VALUES (${userId}, 'fact', '用户已搬到深圳', 'user', 'residence.city', '深圳', 'active', now())
      RETURNING id
    `);
    const newId = rNew.rows[0]!.id;

    await db.execute(sql`
      INSERT INTO memory_embeddings
        (memory_id, model, dim, embedded_text, content_hash, embedding, status)
      VALUES (${newId}, ${EMBEDDING_MODEL_ID}, ${EMBEDDING_DIM}, ${supersedeText},
              ${await sha256Hex(supersedeText)}, ${toVectorLiteral(newVec)}::vector, 'ready')
    `);

    // 旧的写 valid_until + superseded_by（正文不动）
    await db.execute(sql`
      UPDATE memories
         SET status='superseded', valid_until=now(), superseded_by=${newId}
       WHERE id = ${oldId}
    `);

    const chain = await db.execute<{ content: string; status: string; sup: string | null }>(sql`
      SELECT content, status, superseded_by::text AS sup FROM memories
       WHERE id IN (${oldId}, ${newId}) ORDER BY status
    `);
    const oldRow = chain.rows.find((x) => x.status === 'superseded');
    const newRow = chain.rows.find((x) => x.status === 'active');

    if (oldRow && newRow && oldRow.sup === newId && oldRow.content === '用户住在广州') {
      ok('supersede 正确：旧记忆正文未变、标记为 superseded 并指向新记忆');
    } else {
      fail('supersede 行为不符合预期');
    }

    // 检索不应再召回旧记忆
    const activeOnly = await db.execute<{ content: string }>(sql`
      SELECT content FROM memories
       WHERE user_id = ${userId} AND status='active'
         AND deleted_at IS NULL AND valid_until IS NULL AND superseded_by IS NULL
    `);
    const contents = activeOnly.rows.map((r) => r.content);
    if (!contents.includes('用户住在广州') && contents.includes('用户已搬到深圳')) {
      ok('检索结果中旧事实已被新事实取代');
    } else {
      fail(`检索结果异常：${contents.join(' / ')}`);
    }

    // ---------- 5. 中文关键词通道（pg_trgm）----------
    const kw = await db.execute<{ content: string }>(sql`
      SELECT content FROM memories
       WHERE user_id = ${userId} AND content ILIKE '%技术解释%'
    `);
    if (kw.rows.length === 1) {
      ok('pg_trgm 中文关键词通道可用');
    } else {
      fail(`关键词检索返回 ${kw.rows.length} 条（期望 1）`);
    }
  } finally {
    await db.execute(sql`ROLLBACK`);
  }

  console.log('\n端到端验证结果');
  console.log('='.repeat(70));
  for (const l of log) console.log(l);
  console.log('='.repeat(70));
  console.log(
    `\n配置：embedding=${env.EMBEDDING_BASE_URL}  model=${EMBEDDING_MODEL_ID}  dim=${EMBEDDING_DIM}`
  );
  const failed = log.filter((l) => l.includes('[FAIL]')).length;
  console.log(`通过 ${log.length - failed}/${log.length}（已回滚，未留数据）\n`);
  if (failed > 0) process.exitCode = 1;
}

async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

main()
  .catch((err: unknown) => {
    console.error('\n端到端验证失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
