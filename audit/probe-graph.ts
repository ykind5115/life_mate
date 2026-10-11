/**
 * 探针：知识图谱在真实数据下长什么样（docs/16 §3.3）
 *
 * 【为什么必须真看一眼】
 *   图谱这种东西「编译通过」与「画出来有信息」是两码事。
 *   库里人际关系 0 条、目标 0 条 —— 如果组装逻辑只依赖它们，
 *   画出来就是孤点。这个探针回答：实际有多少节点、多少边。
 */
import { buildKnowledgeGraph } from '../src/timeline/knowledge-graph.js';
import { getOrCreateDefaultUser } from '../src/database/repository/index.js';
import { closePool } from '../src/database/client.js';

const user = await getOrCreateDefaultUser();
console.log(`用户 = ${user.name}（${user.timezone}）\n`);

const g = await buildKnowledgeGraph({ userId: user.id, userName: user.name });

console.log('══ 统计 ══');
console.log(JSON.stringify(g.stats, null, 2));

console.log(`\n══ 节点（${g.nodes.length}）══`);
const byKind = new Map<string, typeof g.nodes>();
for (const n of g.nodes) {
  const arr = byKind.get(n.kind) ?? [];
  arr.push(n);
  byKind.set(n.kind, arr);
}
for (const [kind, list] of byKind) {
  console.log(`\n[${kind}] ${list.length} 个`);
  for (const n of list.slice(0, 14)) {
    const badge = n.count !== undefined ? ` (${n.count})` : '';
    const cat = n.category ? ` <${n.category}>` : '';
    console.log(`   ${n.label}${badge}${cat}  w=${n.weight.toFixed(2)}`);
  }
}

console.log(`\n══ 边（${g.edges.length}）══`);
const byEdge = new Map<string, number>();
for (const e of g.edges) byEdge.set(e.kind, (byEdge.get(e.kind) ?? 0) + 1);
for (const [kind, n] of byEdge) console.log(`   ${kind}: ${n}`);

/** 孤立节点检查：没有任何边连着的节点在图里是「看不见的意义」 */
const connected = new Set<string>();
for (const e of g.edges) {
  connected.add(e.source);
  connected.add(e.target);
}
const orphans = g.nodes.filter((n) => !connected.has(n.id));
console.log(`\n孤立节点：${orphans.length} 个${orphans.length > 0 ? ' ← 应当为 0' : ' ✅'}`);
for (const o of orphans.slice(0, 5)) console.log(`   ${o.kind}: ${o.label}`);

await closePool();
process.exit(0);
