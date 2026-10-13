/**
 * 语音转文字路由的测试（docs/17 §3）
 *
 * 【这份测试故意只覆盖「不需要 whisper 服务」的路径】
 *   校验、拒收、上限这些逻辑**不该依赖外部服务**：
 *   它们必须在请求打到 Whisper 之前就生效。
 *   而真正的转写质量只能靠容器起来之后手工验证 ——
 *   这里测不了，也不该假装测了。
 *
 * 【为什么这些拒收路径值得逐条测】
 *   它们的失败方式是**静默的坏结果**，不是报错：
 *     · 不校验格式 → 把非音频字节喂给 Whisper，它吐出一段
 *       看着像文本的幻觉，而用户以为那就是自己说的话
 *     · 不校验时长 → 一段 20 分钟的录音一直占着 GPU 与连接
 *     · 超限时截断而不是拒绝 → 用户以为说全了，其实只转了一半
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { encodeWav16kMono } from '../shared/wav.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { closePool } from '../database/client.js';

/** 起一个最小服务（不传抽取触发器 = 不触发，不碰数据库） */
async function withTranscribe(fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
  assertTestDatabase('transcribe-routes.test.ts / withTranscribe');

  const app = await buildServer({
    logLevel: 'silent',
    // 这些用例不该真的跑抽取 —— 不传就是「不触发」（见 BuildServerOptions）
  });

  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** 造一段静音 WAV */
function wavOf(seconds: number): Buffer {
  return encodeWav16kMono(new Float32Array(Math.round(seconds * 16_000)));
}

// ============================================================
// 请求形态校验
// ============================================================

test('非音频的 Content-Type → 400，且提示里说清接受什么', async () => {
  await withTranscribe(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });

    assert.equal(res.statusCode, 400);
    const message = res.json().error.message as string;
    assert.match(message, /不支持/, '要说清是不支持的格式');
    assert.match(message, /WAV/, '要告诉用户接受什么');
  });
});

test('没有 Content-Type → 400', async () => {
  await withTranscribe(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      payload: Buffer.alloc(100),
    });
    assert.equal(res.statusCode, 400);
  });
});

test('空音频 → 400（不是 500）', async () => {
  await withTranscribe(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: Buffer.alloc(0),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message as string, /没有收到/);
  });
});

// ============================================================
// 音频内容校验 —— 这几条守的是「别喂给 Whisper 猜」
// ============================================================

test('🔴 声明是 WAV 但内容是垃圾 → 400，不送进 Whisper', async () => {
  /**
   * 这是最重要的一条：如果放过去，Whisper 会对一段噪音
   * 输出看起来很像人话的幻觉文本，而用户以为那就是自己说的。
   */
  await withTranscribe(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: Buffer.from('这不是音频，是一段随便的中文文本，长度足够绕过最小长度检查了已经'),
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message as string, /无法识别/);
  });
});

test('非 PCM 的 WAV → 400（在到达服务之前就挡下）', async () => {
  await withTranscribe(async (app) => {
    const wav = Buffer.from(wavOf(0.2));
    wav.writeUInt16LE(3, 20); // 格式码改成 IEEE float

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: wav,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message as string, /PCM/);
  });
});

// ============================================================
// 上限 —— 超限要明确拒绝并告知，不截断
// ============================================================

test('🔴 超过时长上限 → 413，且告知录了多久、上限多少', async () => {
  /**
   * ⚠️ 这里必须是**拒绝**而不是截断。
   *    截断后 Whisper 会对着半句话输出一段看似合理的文本，
   *    而用户以为那就是自己说的全部 —— 那比报错糟得多。
   */
  await withTranscribe(async (app) => {
    // 默认上限 300 秒。造一段 301 秒的（约 9.6MB，在大小上限之内）
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: wavOf(301),
    });

    assert.equal(res.statusCode, 413, `期望 413，实际 ${res.statusCode}`);
    const message = res.json().error.message as string;
    assert.match(message, /301|超过/, '要说清录了多久');
    assert.match(message, /300/, '要给出上限，用户才知道该录多短');
    assert.match(message, /分几次/, '要给下一步怎么做，而不只是报错');
  });
});

test('刚好在上限内的录音不会被误拒（边界）', async () => {
  await withTranscribe(async (app) => {
    /**
     * 299 秒（约 9.5MB）应当通过校验、进入调用 STT 那一步。
     * STT 服务在本测试环境里不可达，所以最终会失败 ——
     * 但**必须是 503（服务不可用）而不是 413/400（输入被拒）**。
     * 这正好把「校验通过」与「校验失败」区分开。
     */
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: wavOf(299),
    });

    assert.notEqual(res.statusCode, 413, '299 秒不该被当成超限');
    assert.notEqual(res.statusCode, 400, '299 秒的合法 WAV 不该被当成坏输入');
  });
});

// ============================================================
// 可用性探测
// ============================================================

test('GET /transcribe/status 在服务不可达时返回 available=false（而不是报错）', async () => {
  /**
   * 前端靠这个决定要不要显示麦克风按钮。
   * 它**必须永远成功返回** —— 语音只是可选的输入方式，
   * 探测失败不该让界面报错，更不该影响打字。
   */
  await withTranscribe(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/transcribe/status' });

    assert.equal(res.statusCode, 200, '探测本身不该失败');
    const data = res.json().data as { available: boolean; max_seconds: number };
    assert.equal(typeof data.available, 'boolean');
    assert.equal(typeof data.max_seconds, 'number');
    // 本地没有跑 whisper 时应当是可用的反面
    assert.equal(data.available, false, '本测试环境没有 STT 服务，应当报不可用');
  });
});

test('清理连接池', async () => {
  await closePool();
});
