/**
 * Settings 路由与 auto_extract 开关的集成测试
 *
 * 【本文件的重点】
 *   ① 不泄露敏感配置（§49）：响应里不能出现 API Key、连接串、内部地址
 *   ② 白名单模式（§16.3）：未知键必须报错，不能静默丢弃
 *   ③ **auto_extract 真的能关掉抽取** —— 否则它就是个假开关。
 *      这条最容易只做成"设置页显示对了"，而实际照抽不误。
 *
 * 前置：pnpm test（脚本已指定 .env.test → lifemate_test）
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { users } from '../database/schema/users.js';
import { resolveTestUser } from '../database/repository/_test-helpers.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { emptyDiagnostics } from '../memory/extraction-schema.js';
import { buildServer } from './server.js';
import { IdempotencyStore } from './idempotency.js';
import { ExtractionTrigger } from '../conversation/extraction-trigger.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import type { LLMGenerateResult, LLMStreamChunk } from '../llm/types.js';

after(async () => {
  await closePool();
});

// ============================================================
// 夹具
// ============================================================

class StubProvider implements LLMProvider {
  readonly providerName = 'stub';
  readonly defaultModel = 'stub-model';

  constructor(private readonly answer = '好的。') {}

  generate(_input: GenerateInput): Promise<LLMGenerateResult> {
    return Promise.resolve({
      content: this.answer,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      model: 'stub-model',
      finishReason: 'stop',
    });
  }

  async *stream(): AsyncIterable<LLMStreamChunk> {
    yield { type: 'token', content: this.answer };
    yield {
      type: 'done',
      result: {
        content: this.answer,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        model: 'stub-model',
        finishReason: 'stop',
      },
    };
  }
}

/** 记录被触发了几次抽取，但不真的抽 */
function recordingTrigger(): { trigger: ExtractionTrigger; calls: string[] } {
  const calls: string[] = [];
  const trigger = new ExtractionTrigger({
    minMessages: 1,
    run: async (params) => {
      calls.push(params.conversationId);
      return emptySummary();
    },
  });
  return { trigger, calls };
}

function emptySummary() {
  return {
    executed: false as const,
    skippedReason: 'no_new_messages' as const,
    candidatesFound: 0,
    // 用共享的空诊断构造函数：ExtractionDiagnostics 加字段时只需改一处
    diagnostics: emptyDiagnostics(),
    outcomes: { created: 0, merged: 0, superseded: 0, conflict: 0 },
    events: { created: 0, skippedDuplicates: 0 },
    adjudicationCalls: 0,
    embeddings: { succeeded: 0, failed: 0 },
    memoriesWithoutEmbedding: [],
  };
}

/**
 * 建测试服务器。
 *
 * ⚠️ 每个用例前后都把默认用户的 settings 与 timezone 复位 ——
 *    它们在用例之间是共享状态（单用户系统），不复位会串。
 */
async function withSettings(
  fn: (ctx: {
    app: FastifyInstance;
    extractionCalls: string[];
    resetSettings: () => Promise<void>;
  }) => Promise<void>
): Promise<void> {
  assertTestDatabase('settings-routes.test.ts / withSettings');

  const { trigger, calls } = recordingTrigger();
  const app = await buildServer({
    logLevel: 'silent',
    provider: new StubProvider(),
    chatIdempotency: new IdempotencyStore(),
    extractionTrigger: trigger,
    retrieveMemories: null,
  });

  const user = await resolveTestUser('settings-routes.test.ts');

  const resetSettings = async (): Promise<void> => {
    await db
      .update(users)
      .set({ settings: {}, timezone: 'Asia/Shanghai' })
      .where(eq(users.id, user.id));
  };

  await resetSettings();

  try {
    await fn({ app, extractionCalls: calls, resetSettings });
  } finally {
    await app.close();
    await resetSettings();
  }
}

function req(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

// ============================================================
// GET
// ============================================================

test('GET /settings 返回模型、auto_extract 与时区，且缺省 auto_extract=true', async () => {
  await withSettings(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/settings' });
    assert.equal(res.statusCode, 200);

    const data = res.json().data;
    assert.equal(data.memory.auto_extract, true, '缺省应为 true（docs/04 §36）');
    assert.equal(data.timezone, 'Asia/Shanghai');
    assert.ok(data.model.provider);
    assert.ok(data.model.model);
  });
});

test('GET /settings 不泄露任何敏感配置（§49）', async () => {
  await withSettings(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/settings' });
    const text = JSON.stringify(res.json());

    /**
     * 这是安全断言，不是格式断言。
     * 本端点是「读取系统配置」，最容易在开发时顺手把整个 env 返回出去。
     */
    assert.doesNotMatch(text, /sk-/, '不应出现 API Key');
    assert.doesNotMatch(text, /postgresql:\/\//, '不应出现数据库连接串');
    assert.doesNotMatch(text, /api\.deepseek\.com/, '不应出现上游地址');
    assert.doesNotMatch(text, /LLM_API_KEY|DATABASE_URL/, '不应出现凭据类环境变量名');
  });
});

test('GET /settings 未设置的偏好不出现在响应里（可区分"没选过"）', async () => {
  await withSettings(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/settings' });
    const prefs = res.json().data.preferences;

    assert.deepEqual(prefs, {}, '未设置过任何偏好时，preferences 应为空对象');
  });
});

// ============================================================
// PATCH
// ============================================================

test('PATCH /settings 关闭 auto_extract 后 GET 能读到', async () => {
  await withSettings(async ({ app }) => {
    const patch = await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { memory: { auto_extract: false } },
    });

    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().data.memory.auto_extract, false);

    const get = await req(app, { method: 'GET', url: '/api/v1/settings' });
    assert.equal(get.json().data.memory.auto_extract, false);
  });
});

test('PATCH /settings 是合并语义：只传一个键不会清掉其他键', async () => {
  await withSettings(async ({ app }) => {
    await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { response_style: 'direct', display_name: '阿泽' },
    });

    // 只改 auto_extract，不该把上面两个键清掉
    await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { memory: { auto_extract: false } },
    });

    const get = await req(app, { method: 'GET', url: '/api/v1/settings' });
    const prefs = get.json().data.preferences;

    assert.equal(prefs.response_style, 'direct', 'PATCH 必须是合并，不是整体替换');
    assert.equal(prefs.display_name, '阿泽');
    assert.equal(get.json().data.memory.auto_extract, false);
  });
});

test('PATCH /settings 接受 docs/03 §8.4 白名单里的所有枚举值', async () => {
  await withSettings(async ({ app }) => {
    /**
     * ⚠️ 这条测试是为了防止"臆造枚举值"。
     *    本文件对应的 schema 第一版把 response_style 写成了
     *    `concise | detailed`，而文档给的是 `direct | gentle | detailed` ——
     *    前端按文档传 direct 会被拒。
     */
    for (const style of ['direct', 'gentle', 'detailed'] as const) {
      const res = await req(app, {
        method: 'PATCH',
        url: '/api/v1/settings',
        payload: { response_style: style },
      });
      assert.equal(res.statusCode, 200, `response_style=${style} 应被接受（§8.4）`);
    }

    for (const len of ['short', 'medium', 'long'] as const) {
      const res = await req(app, {
        method: 'PATCH',
        url: '/api/v1/settings',
        payload: { response_length: len },
      });
      assert.equal(res.statusCode, 200, `response_length=${len} 应被接受（§8.4）`);
    }
  });
});

test('PATCH /settings 未知键 → 422（白名单模式，§16.3）', async () => {
  await withSettings(async ({ app }) => {
    const res = await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { is_admin: true },
    });

    // 静默丢弃未知键会让调用方以为设置生效了
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});

test('PATCH /settings 枚举外的值 → 422', async () => {
  await withSettings(async ({ app }) => {
    const res = await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { response_style: 'sarcastic' },
    });

    assert.equal(res.statusCode, 422);
  });
});

test('PATCH /settings 可以改时区', async () => {
  await withSettings(async ({ app }) => {
    const res = await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { timezone: 'America/New_York' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.timezone, 'America/New_York');

    const get = await req(app, { method: 'GET', url: '/api/v1/settings' });
    assert.equal(get.json().data.timezone, 'America/New_York');
  });
});

test('PATCH /settings 空 body 不报错，也不改动任何设置', async () => {
  await withSettings(async ({ app }) => {
    await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { display_name: '保留我' },
    });

    const res = await req(app, { method: 'PATCH', url: '/api/v1/settings', payload: {} });
    assert.equal(res.statusCode, 200);

    const get = await req(app, { method: 'GET', url: '/api/v1/settings' });
    assert.equal(get.json().data.preferences.display_name, '保留我');
  });
});

// ============================================================
// auto_extract 的实际效果（本文件最重要的一条）
// ============================================================

test('auto_extract=true 时聊天会触发抽取', async () => {
  await withSettings(async ({ app, extractionCalls }) => {
    await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { memory: { auto_extract: true } },
    });

    await req(app, {
      method: 'POST',
      url: '/api/v1/chat',
      payload: { message: '我最近在学吉他' },
    });

    // schedule 是异步的，给它一点时间跑到 run
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(extractionCalls.length > 0, '开启时应触发抽取');
  });
});

test('auto_extract=false 时聊天**不**触发抽取', async () => {
  await withSettings(async ({ app, extractionCalls }) => {
    await req(app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { memory: { auto_extract: false } },
    });

    const chat = await req(app, {
      method: 'POST',
      url: '/api/v1/chat',
      payload: { message: '这句话不该被记住' },
    });
    assert.equal(chat.statusCode, 200, '关掉抽取不影响聊天本身');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      extractionCalls.length,
      0,
      '关掉后不该触发抽取 —— 否则这个开关是假的'
    );
  });
});
