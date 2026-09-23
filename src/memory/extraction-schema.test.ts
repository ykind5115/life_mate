/**
 * 抽取契约分级策略测试
 *
 * 这组测试锁住一条**实测踩到的教训**：
 *   模型某次给了 predicateKey 却漏 objectValue，而当时的实现整批抛错，
 *   把同批里 5 条完全合格的记忆一起丢掉了。
 *
 * 分级策略（详见 extraction-schema.ts 文件头）：
 *   容器级错误（JSON 坏、顶层结构坏）→ 整批失败
 *   条目级错误（type 非法、content 空）→ 丢弃该条，保留其余
 *   字段级错误（槽位不成对、词表外槽位）→ 降级该字段，保留该条
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseExtractionResult,
  parseExtractionResultWithDiagnostics,
} from './extraction-schema.js';

// ============================================================
// 容器级：整批失败
// ============================================================

test('容器级：JSON 无法解析 → 整批抛错（不能静默返回空）', () => {
  assert.throws(
    () => parseExtractionResultWithDiagnostics('这不是 JSON'),
    /容器级错误/
  );
});

test('容器级：memories 不是数组 → 整批抛错', () => {
  assert.throws(
    () => parseExtractionResultWithDiagnostics('{"memories":"不是数组"}'),
    /顶层结构不符合契约|容器级错误/
  );
});

test('容器级：顶层不是对象也不是数组 → 整批抛错', () => {
  assert.throws(
    () => parseExtractionResultWithDiagnostics('"就是一个字符串"'),
    /顶层结构不符合契约|容器级错误/
  );
});

test('容器级错误必须抛错而不是返回空 —— 空结果会被当成「没有值得记的内容」', () => {
  // 这是抽取流水线最危险的失败模式：静默丢记忆
  let threw = false;
  try {
    parseExtractionResultWithDiagnostics('{坏掉的 json');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, '容器级错误必须抛错，绝不能返回空 memories 数组');
});

// ============================================================
// 条目级：丢弃该条，保留其余
// ============================================================

test('条目级：单条 type 非法 → 只丢该条，其余保留（实测的教训）', () => {
  const raw = JSON.stringify({
    memories: [
      { type: 'fact', content: '用户住在广州', predicateKey: 'residence.city', objectValue: '广州' },
      { type: 'not_a_type', content: '这条类型非法' },
      { type: 'preference', content: '用户喜欢简洁回答' },
    ],
  });

  const { result, diagnostics } = parseExtractionResultWithDiagnostics(raw);

  assert.equal(result.memories.length, 2, '两条合格的应保留');
  assert.equal(diagnostics.rawCount, 3);
  assert.equal(diagnostics.validCount, 2);
  assert.equal(diagnostics.dropped.length, 1);
  assert.equal(diagnostics.dropped[0]?.index, 1, '应记录被丢弃条目的下标');
  assert.ok(diagnostics.dropped[0]?.reason.includes('type'));
});

test('条目级：单条 content 为空 → 只丢该条', () => {
  const raw = JSON.stringify({
    memories: [
      { type: 'fact', content: '' },
      { type: 'fact', content: '用户从事后端开发' },
    ],
  });

  const { result, diagnostics } = parseExtractionResultWithDiagnostics(raw);

  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0]?.content, '用户从事后端开发');
  assert.equal(diagnostics.dropped.length, 1);
});

test('条目级：content 超长 → 只丢该条', () => {
  const raw = JSON.stringify({
    memories: [
      { type: 'fact', content: 'x'.repeat(600) },
      { type: 'fact', content: '正常内容' },
    ],
  });

  const { result, diagnostics } = parseExtractionResultWithDiagnostics(raw);
  assert.equal(result.memories.length, 1);
  assert.equal(diagnostics.dropped.length, 1);
});

test('条目级：完全不是对象的条目 → 只丢该条', () => {
  const raw = JSON.stringify({
    memories: ['这是个字符串', 42, null, { type: 'fact', content: '正常' }],
  });

  const { result, diagnostics } = parseExtractionResultWithDiagnostics(raw);
  assert.equal(result.memories.length, 1);
  assert.equal(diagnostics.dropped.length, 3);
});

// ============================================================
// 字段级：降级该字段，保留该条（最关键的一组）
// ============================================================

test('字段级：有槽位但无取值 → 降级为无槽位，但**保留记忆**', () => {
  // 这正是实测踩到的场景：模型给了 predicateKey 却漏 objectValue
  const raw = JSON.stringify({
    memories: [
      { type: 'fact', content: '用户住在广州', predicateKey: 'residence.city' },
      { type: 'fact', content: '用户从事后端开发', predicateKey: 'employment.role', objectValue: '后端开发' },
    ],
  });

  const { result, diagnostics } = parseExtractionResultWithDiagnostics(raw);

  // 关键断言：内容被保留了，没有因为一个字段的问题丢掉整条
  assert.equal(result.memories.length, 2, '两条都应保留');
  assert.equal(result.memories[0]?.content, '用户住在广州');

  // 槽位被降级（用 == null 兼容 null/undefined，两者都表示「无槽位」）
  assert.ok(result.memories[0]?.predicateKey == null);
  assert.ok(result.memories[0]?.objectValue == null);

  // 第二条不受影响
  assert.equal(result.memories[1]?.predicateKey, 'employment.role');

  // 降级事实被记录，不静默
  assert.equal(diagnostics.degradations.length, 1);
  assert.equal(diagnostics.degradations[0]?.field, 'objectValue');
  assert.match(diagnostics.degradations[0]?.action ?? '', /去掉槽位/);
});

test('字段级：词表外的槽位 → 降级为无槽位，保留记忆并记录诊断', () => {
  const raw = JSON.stringify({
    memories: [
      {
        type: 'fact',
        content: '用户在某事上很在行',
        predicateKey: 'made.up.slot',
        objectValue: '某值',
      },
    ],
  });

  const { result, diagnostics } = parseExtractionResultWithDiagnostics(raw);

  assert.equal(result.memories.length, 1, '内容有价值，不该因为槽位非法就丢掉');
  assert.ok(result.memories[0]?.predicateKey == null, '槽位应被降级为无槽位');
  assert.ok(result.memories[0]?.objectValue == null, '取值也应一并去掉，避免半残状态');

  // 只应有一条降级记录。
  // 若出现两条（词表外 + 有取值但无槽位），那是同一个根因被记了两次 ——
  // 会产出误导性诊断，让人以为模型漏给了槽位。
  assert.equal(diagnostics.degradations.length, 1, '同一根因只应记录一条诊断');
  assert.equal(diagnostics.degradations[0]?.field, 'predicateKey');
  assert.match(diagnostics.degradations[0]?.original ?? '', /made\.up\.slot/);
  assert.match(diagnostics.degradations[0]?.action ?? '', /无槽位/);
});

test('字段级：有取值但无槽位 → 去掉取值', () => {
  const raw = JSON.stringify({
    memories: [{ type: 'fact', content: '用户的情况', objectValue: '孤儿取值' }],
  });

  const { result, diagnostics } = parseExtractionResultWithDiagnostics(raw);

  assert.equal(result.memories.length, 1);
  assert.ok(result.memories[0]?.predicateKey == null);
  assert.ok(result.memories[0]?.objectValue == null);
  assert.equal(diagnostics.degradations.length, 1);
  assert.equal(diagnostics.degradations[0]?.field, 'predicateKey');
});

test('字段级：importance/confidence 越界 → 收敛为缺省值，不丢条目', () => {
  const raw = JSON.stringify({
    memories: [
      { type: 'fact', content: '内容甲', importance: 5, confidence: -3 },
    ],
  });

  const { result } = parseExtractionResultWithDiagnostics(raw);

  assert.equal(result.memories.length, 1, '数值越界不该丢条目');
  // .catch() 收敛到各自缺省
  assert.equal(result.memories[0]?.importance, 0.5);
  assert.equal(result.memories[0]?.confidence, 1);
});

// ============================================================
// 槽位命中率诊断
// ============================================================

test('诊断：槽位命中率统计正确（结构化抽取是否有效的指标）', () => {
  const raw = JSON.stringify({
    memories: [
      { type: 'fact', content: '甲', predicateKey: 'residence.city', objectValue: '广州' },
      { type: 'fact', content: '乙', predicateKey: 'employment.role', objectValue: '后端' },
      { type: 'state', content: '丙' }, // 无槽位（合法）
      { type: 'fact', content: '丁', predicateKey: 'bad.slot', objectValue: 'x' }, // 降级
    ],
  });

  const { diagnostics } = parseExtractionResultWithDiagnostics(raw);

  assert.equal(diagnostics.rawCount, 4);
  assert.equal(diagnostics.validCount, 4, '降级不丢条目');
  assert.equal(diagnostics.slotCoverage.withSlot, 2);
  assert.equal(diagnostics.slotCoverage.total, 4);
  assert.equal(diagnostics.degradations.length, 1);
});

test('诊断：空结果时各项为 0，不报错', () => {
  const { result, diagnostics } = parseExtractionResultWithDiagnostics('{"memories":[]}');
  assert.deepEqual(result.memories, []);
  assert.equal(diagnostics.rawCount, 0);
  assert.equal(diagnostics.slotCoverage.total, 0);
  assert.deepEqual(diagnostics.dropped, []);
});

// ============================================================
// 格式容忍性（与分级策略正交，但要保证没被改坏）
// ============================================================

test('容错：剥离 markdown 代码块', () => {
  const r = parseExtractionResult(
    '```json\n{"memories":[{"type":"fact","content":"用户在学习 TS"}]}\n```'
  );
  assert.equal(r.memories.length, 1);
});

test('容错：前后有解释文字', () => {
  const r = parseExtractionResult(
    '好的：\n{"memories":[{"type":"preference","content":"用户偏好简洁"}]}\n以上。'
  );
  assert.equal(r.memories.length, 1);
});

test('容错：顶层直接是数组', () => {
  const r = parseExtractionResult('[{"type":"fact","content":"用户住在上海"}]');
  assert.equal(r.memories.length, 1);
});

test('兼容入口 parseExtractionResult 只返回结果、不返回诊断', () => {
  const r = parseExtractionResult(
    JSON.stringify({
      memories: [{ type: 'fact', content: '甲' }, { type: 'bad', content: '乙' }],
    })
  );
  assert.equal(r.memories.length, 1, '兼容入口同样应用分级策略');
});
