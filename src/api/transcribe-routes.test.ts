/**
 * 语音转文字路由的测试（docs/17 §3）
 *
 * 【这份测试覆盖「不需要 whisper 服务」的路径】
 *   校验、拒收、上限这些逻辑**不该依赖外部服务**：
 *   它们必须在请求打到 Whisper 之前就生效。
 *
 * 【为什么这些拒收路径值得逐条测】
 *   它们的失败方式是**静默的坏结果**，不是报错：
 *     · 不校验格式 → 把非音频喂给 Whisper，它吐出一段看着像文本的幻觉
 *     · 不校验时长 → 一段 20 分钟的录音一直占着 GPU 与连接
 *     · 超限时截断而不是拒绝 → 用户以为说全了，其实只转了一半
 *
 * 【上游接口形态是实测确认的】（见 llm/stt.ts 的文件头）
 *   最初按文档猜「原始字节 + Content-Type」，实测被 422 拒绝：
 *     {"detail":[{"loc":["body","audio_file"],"msg":"Field required"}]}
 *   因此这里有一条测试专门守住「本接口要 multipart」，
 *   防止将来有人又把它改回裸字节 —— 那会让前端整条链路失效。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { encodeWav16kMono } from '../shared/wav.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { closePool } from '../database/client.js';

async function withTranscribe(fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
  assertTestDatabase('transcribe-routes.test.ts / withTranscribe');
  // 不传抽取触发器 = 不触发；这些用例不该真的跑抽取
  const app = await buildServer({ logLevel: 'silent' });

  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

function wavOf(seconds: number): Buffer {
  return encodeWav16kMono(new Float32Array(Math.round(seconds * 16_000)));
}

/**
 * 手工拼一个 multipart 请求体。
 *
 * 用 inject 时不方便直接传 FormData，所以自己拼边界。
 * 这同时也在验证「服务端确实按 multipart 解析」——
 * 如果哪天改成裸字节，这些用例会失败。
 */
function multipartBody(field: string, filename: string, data: Buffer) {
  const boundary = '----lifemateTestBoundary1234567890';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  return {
    boundary,
    payload: Buffer.concat([Buffer.from(head, 'utf8'), data, Buffer.from(tail, 'utf8')]),
  };
}

function injectAudio(app: FastifyInstance, audio: Buffer, field = 'audio') {
  const { boundary, payload } = multipartBody(field, 'speech.wav', audio);
  return app.inject({
    method: 'POST',
    url: '/api/v1/transcribe',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

// ============================================================
// 请求形态
// ============================================================

test('🔴 不是 multipart 的请求被拒（上游只收 multipart，实测结论）', async () => {
  /**
   * 这条守的是**协议本身**。
   * 最初实现成「正文直接是音频字节」，实测被上游 422 拒绝。
   * 若有人又改回裸字节，前端整条链路会失效 —— 让这条测试拦住。
   *
   * ⚠️ 断言放宽到「4xx 且被拒」，不写死 400：
   *    实测是 fastify 的 content-type 解析器先挡下，返回 **415
   *    Unsupported Media Type**。415 是更准确的语义，没必要为了
   *    统一成 400 去和框架较劲。这条测试要守的是「被拒绝」，
   *    不是「用哪个码拒绝」。
   */
  await withTranscribe(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: wavOf(1),
    });

    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `裸字节应当被拒（4xx），实际 ${res.statusCode}`
    );
    // 关键：绝不能悄悄接受 —— 那会让前端以为上传成功了
    assert.notEqual(res.statusCode, 200);
    assert.notEqual(res.statusCode, 201);
  });
});

test('JSON 请求体 → 400（不是 500）', async () => {
  await withTranscribe(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transcribe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(res.statusCode, 400);
  });
});

test('空音频 → 400', async () => {
  await withTranscribe(async (app) => {
    const res = await injectAudio(app, Buffer.alloc(0));
    assert.equal(res.statusCode, 400);
  });
});

// ============================================================
// 音频内容校验 —— 守「别喂给 Whisper 猜」
// ============================================================

test('🔴 声明是 WAV 但内容是垃圾 → 400，不送进 Whisper', async () => {
  /**
   * 最重要的一条：放过去的话，Whisper 会对一段噪音输出看起来很像人话的
   * 文本（实测：静音 → 电视剧台词），而用户以为那就是自己说的。
   */
  await withTranscribe(async (app) => {
    const res = await injectAudio(
      app,
      Buffer.from('这不是音频，是一段随便的中文文本，长度足够绕过最小长度检查了已经')
    );

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message as string, /无法识别/);
  });
});

test('非 PCM 的 WAV → 400（到达服务之前就挡下）', async () => {
  await withTranscribe(async (app) => {
    const wav = Buffer.from(wavOf(1));
    wav.writeUInt16LE(3, 20); // 格式码改成 IEEE float

    const res = await injectAudio(app, wav);
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message as string, /PCM/);
  });
});

test('🔴 过短的录音 → 400 并说明太短（不是 503）', async () => {
  /**
   * 实测依据：1.16 秒的真实人声「嗯」被识别成 "ben"。
   * 更短的片段几乎必然产出垃圾文本 —— 与其让用户对着一句假文本发愣，
   * 不如直接说太短。
   *
   * ⚠️ 这条测试抓出过我一个真实的错误映射：
   *    最初「太短」被当成服务故障返回 **503**，
   *    用户看到「服务暂不可用，稍后再试」—— 而重试一百次都一样。
   *    输入问题必须与故障分开，否则用户会去查一个不存在的故障。
   */
  await withTranscribe(async (app) => {
    const res = await injectAudio(app, wavOf(0.2));

    assert.equal(res.statusCode, 400, `期望 400（输入问题），实际 ${res.statusCode}`);
    assert.match(res.json().error.message as string, /太短/);
  });
});

// ============================================================
// 上限 —— 超限明确拒绝，不截断
// ============================================================

test('🔴 超过时长上限 → 413，且告知录了多久、上限多少', async () => {
  /**
   * ⚠️ 必须是**拒绝**而不是截断。
   *    截断后 Whisper 会对着半句话输出一段看似合理的文本，
   *    而用户以为那就是自己说的全部 —— 那比报错糟得多。
   */
  await withTranscribe(async (app) => {
    const res = await injectAudio(app, wavOf(301)); // 默认上限 300 秒

    assert.equal(res.statusCode, 413, `期望 413，实际 ${res.statusCode}`);
    const message = res.json().error.message as string;
    assert.match(message, /301|超过/, '要说清录了多久');
    assert.match(message, /300/, '要给出上限');
    assert.match(message, /分几次/, '要给下一步怎么做');
  });
});

test('刚好在上限内的录音通过校验（边界）', async () => {
  await withTranscribe(async (app) => {
    /**
     * 299 秒应当通过校验、进入调用 STT 那一步。
     * 真 STT 在测试环境未必可用，因此只断言**它不是输入被拒**（400/413）。
     */
    const res = await injectAudio(app, wavOf(299));
    assert.notEqual(res.statusCode, 413, '299 秒不该被当成超限');
    assert.notEqual(res.statusCode, 400, '299 秒的合法 WAV 不该被当成坏输入');
  });
});

// ============================================================
// 可用性探测
// ============================================================

test('GET /transcribe/status 永远 200，可用性放在 available 字段里', async () => {
  /**
   * 前端靠它决定要不要显示麦克风按钮。
   * 它**必须永远成功返回** —— 语音只是可选的输入方式，
   * 探测失败不该让界面报错，更不该影响打字。
   */
  await withTranscribe(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/transcribe/status' });

    assert.equal(res.statusCode, 200, '探测本身不该失败');
    const data = res.json().data as { available: boolean; max_seconds: number; model: string };
    assert.equal(typeof data.available, 'boolean');
    assert.equal(typeof data.max_seconds, 'number');
    assert.equal(typeof data.model, 'string');
  });
});

test('清理连接池', async () => {
  await closePool();
});
