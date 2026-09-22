/**
 * 环境配置
 *
 * 依据：《数据库设计 V1.1》与《环境搭建操作手册》
 *
 * 设计要点：
 *   ① 启动即校验，配置缺失/非法时立刻失败，不留到运行中途才暴露
 *   ② 敏感值（密码、API Key）只来自环境变量，永不写入代码
 *      （架构 §37 数据最小化 / §12.1 隐私要求）
 *   ③ embedding 维度是「不可逆决策」的配套值，必须与 docs/03 §4.2 冻结值一致
 *      （审计 F-11 的教训：读到不一致的值会导致检索静默失配）
 */
import { z } from 'zod';

/** docs/03 §4.2 冻结的维度。换模型 = 显式数据迁移，不是配置项。 */
export const EMBEDDING_DIM = 1024;

/** docs/03 §14.5 C27：model 取值必须来自单一常量，禁止各处手写字面量 */
export const EMBEDDING_MODEL_ID = 'BAAI/bge-m3';

const envSchema = z.object({
  // ---------- PostgreSQL ----------
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL 不能为空')
    .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
      message: 'DATABASE_URL 必须是 postgresql:// 或 postgres:// 连接串',
    }),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ---------- 服务端口 ----------
  // 默认只绑回环：本项目保存私密生活数据（docs/03 §29）
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),

  // ---------- Embedding 服务 ----------
  EMBEDDING_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
  EMBEDDING_MODEL: z.string().default(EMBEDDING_MODEL_ID),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(EMBEDDING_DIM),
  /** 单次请求超时（ms）。本地 GPU 推理，正常在 50ms 内，留足余量 */
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ---------- LLM Provider（对话模型）----------
  // 决策：V1.0 使用 DeepSeek
  // ⚠️ 密钥只来自环境变量，永不写进代码或示例（架构 §37 / docs/03 §29）
  LLM_PROVIDER: z.enum(['deepseek', 'openai-compatible']).default('deepseek'),
  LLM_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  /**
   * ⚠️ 用真实模型名，不用别名（2026-09-22 实测）。
   *
   * 该账号 /models 返回的是 deepseek-flash 与 deepseek-v4-pro，
   * 而 'deepseek-chat' 是别名、会被路由到 deepseek-flash ——
   * 表现为「请求 deepseek-chat、返回 model=deepseek-flash」。
   * 用别名会让日志与用量核算里的模型归属不准，因此用真实名。
   * 更换模型前先查 /models 确认可用列表。
   */
  LLM_MODEL: z.string().default('deepseek-flash'),
  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY 不能为空'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** 单轮对话输入 token 预算（docs/01 §12.4 的非功能目标） */
  LLM_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(8_000),

  // ---------- 日志 ----------
  // docs/03 §29.1：日志禁止记录消息正文与记忆内容
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`环境变量校验失败：\n${issues}\n\n请参考 .env.example 配置 .env。`);
  }

  const env = parsed.data;

  // 跨字段一致性：embedding 维度必须与冻结值一致（审计 F-11 同类问题）
  if (env.EMBEDDING_DIM !== EMBEDDING_DIM) {
    throw new Error(
      `EMBEDDING_DIM=${env.EMBEDDING_DIM} 与冻结值 ${EMBEDDING_DIM} 不一致。\n` +
        `memory_embeddings.embedding 的列类型是 VECTOR(${EMBEDDING_DIM})，` +
        `维度不符会导致写入被数据库拒绝或检索静默失配。\n` +
        `详见《数据库设计 V1.1》§4.2 与 §14.2（C36）。`
    );
  }

  if (env.EMBEDDING_MODEL !== EMBEDDING_MODEL_ID) {
    throw new Error(
      `EMBEDDING_MODEL=${env.EMBEDDING_MODEL} 与期望值 ${EMBEDDING_MODEL_ID} 不一致。\n` +
        `model 字段用于检索时的 JOIN 过滤，取值不统一会导致永远召回不到结果（审计 F-11）。`
    );
  }

  return env;
}

export const env: Env = loadEnv();
