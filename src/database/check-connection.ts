/**
 * 连接自检脚本
 *
 * 用途：确认应用侧能连上容器里的 PostgreSQL，并且关键扩展与冻结维度就位。
 * 这是 Phase 3 骨架的验收手段之一。
 *
 * 运行：pnpm db:check   （需 --env-file=.env，见 package.json）
 *
 * 只读检查，不修改任何数据。
 */
import { sql } from 'drizzle-orm';

import { closePool, db } from './client.js';
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from '../shared/env.js';

type CheckResult = { name: string; ok: boolean; detail: string };

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  results.push(
    await check('连接 PostgreSQL', async () => {
      const r = await db.execute<{ version: string }>(sql`SELECT version() AS version`);
      const row = r.rows[0];
      if (!row) throw new Error('查询无返回');
      // 只取版本号前段，避免打印无关信息
      return row.version.split(' on ')[0] ?? row.version;
    })
  );

  results.push(
    await check('服务器时区', async () => {
      // 用 current_setting() 而非 SHOW：SHOW 返回的列名保留大小写（TimeZone），
      // 无法可靠别名；current_setting() 直接返回值，可显式命名列。
      const r = await db.execute<{ tz: string | null }>(
        sql`SELECT current_setting('TimeZone') AS tz`
      );
      const tz = r.rows[0]?.tz;
      if (!tz) throw new Error('未读到 TimeZone');
      if (tz !== 'Asia/Shanghai') {
        throw new Error(`时区为 ${tz}，期望 Asia/Shanghai（见 docker-compose.yml）`);
      }
      return tz;
    })
  );

  results.push(
    await check('扩展 vector / pg_trgm / btree_gist', async () => {
      const r = await db.execute<{ extname: string; extversion: string }>(sql`
        SELECT extname, extversion FROM pg_extension
         WHERE extname IN ('vector','pg_trgm','btree_gist')
         ORDER BY extname
      `);
      const found = r.rows.map((x) => `${x.extname}=${x.extversion}`).join(', ');
      const need = ['vector', 'pg_trgm', 'btree_gist'];
      const missing = need.filter((n) => !r.rows.some((x) => x.extname === n));
      if (missing.length > 0) {
        throw new Error(`缺少扩展：${missing.join(', ')}（已装：${found || '无'}）`);
      }
      return found;
    })
  );

  results.push(
    await check(`VECTOR(${EMBEDDING_DIM}) 维度可用`, async () => {
      // 在临时表上验证维度约束，不污染 schema
      await db.execute(sql.raw(`
        CREATE TEMP TABLE _dim_probe (v vector(${EMBEDDING_DIM}))
      `));
      await db.execute(sql.raw(`
        INSERT INTO _dim_probe (v) VALUES (array_fill(1.0::real, ARRAY[${EMBEDDING_DIM}])::vector)
      `));
      const r = await db.execute<{ n: number }>(sql`
        SELECT vector_dims(v) AS n FROM _dim_probe LIMIT 1
      `);
      const n = r.rows[0]?.n;
      if (n !== EMBEDDING_DIM) throw new Error(`实际维度 ${String(n)}，期望 ${EMBEDDING_DIM}`);
      return `写入并读回 ${n} 维成功`;
    })
  );

  results.push(
    await check('错误维度被拒绝（应失败即通过）', async () => {
      await db.execute(sql.raw(`CREATE TEMP TABLE _dim_probe2 (v vector(${EMBEDDING_DIM}))`));
      try {
        await db.execute(sql.raw(`
          INSERT INTO _dim_probe2 (v) VALUES (array_fill(1.0::real, ARRAY[512])::vector)
        `));
      } catch {
        return '插入 512 维被正确拒绝';
      }
      throw new Error('插入 512 维竟然成功了 —— 维度约束未生效');
    })
  );

  results.push(
    await check('已建业务表数量', async () => {
      const r = await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name NOT LIKE '\\_\\_%'
      `);
      const n = r.rows[0]?.n ?? 0;
      return n === 0
        ? '0 张（尚未执行 migration，符合当前阶段）'
        : `${n} 张`;
    })
  );

  // ---------- 输出 ----------
  console.log('\n数据库自检结果');
  console.log('='.repeat(64));
  for (const r of results) {
    console.log(`${r.ok ? '  [OK]  ' : '  [FAIL]'} ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  console.log('='.repeat(64));

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n配置：model=${EMBEDDING_MODEL_ID}  dim=${EMBEDDING_DIM}  ` +
      `通过 ${results.length - failed.length}/${results.length}\n`
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error('\n自检执行失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
