/**
 * Embedding 客户端（bge-m3，本地 TEI 服务）
 *
 * 依据：docs/03 §14（memory_embeddings）、§25.2（embedding 必须在事务外生成）
 *
 * 【分层位置】
 *   与 llm/ 平级：都是「外部服务客户端」，不是业务逻辑。
 *   业务侧通过它拿向量，不直接拼 HTTP。
 *
 * 【为什么单独成文件而不是塞进 memory/】
 *   embedding 与记忆语义无关，它是检索基础设施（§30 原则六）。
 *   将来换成别的向量服务或本地模型，只改这一层。
 */
import { EMBEDDING_DIM, EMBEDDING_MODEL_ID, env } from '../shared/env.js';

/**
 * 单次嵌入请求的超时。
 *
 * ⚠️ 取 env.EMBEDDING_TIMEOUT_MS，不要在这里另外写常量 ——
 *    那会让 .env 里的配置变成摆设（本文件原先就有一个无人引用的
 *    DEFAULT_TIMEOUT_MS，改 env 时不会有任何效果）。
 */
const timeoutMs = env.EMBEDDING_TIMEOUT_MS;

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly options: { retryable: boolean; status?: number } = { retryable: true }
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * 按 docs/03 §14.5 的规则拼接被向量化的文本。
 *
 *   embedded_text = "{type}｜{主体}｜{content}｜{时间提示}"
 *
 * 为什么把 type 与时间也嵌进去：
 *   只嵌入 content 时，「广州」这个词本身不带类型与时间信息，
 *   导致「用户住在广州」与「用户去广州出差」在向量空间里非常接近。
 *   加上 type 与时间提示能显著改善区分度。
 */
export function buildEmbeddedText(parts: {
  type: string;
  subject: string;
  content: string;
  timeHint?: string | null;
}): string {
  const segments = [parts.type, parts.subject, parts.content];
  if (parts.timeHint) segments.push(parts.timeHint);
  return segments.join('｜');
}

/**
 * 生成嵌入向量。
 *
 * ⚠️ 本函数是**外部调用**，绝不能在数据库事务内执行（§25.2）：
 *   在事务里做会把数据库连接一直持有到推理结束，
 *   且失败时会把记忆本体一起回滚 —— 而记忆本体是该保留的。
 *
 * 关于批量：V1.0 用单条请求（batch=1）。
 *   审计报告 F-12 记录了「TEI 批量返回顺序未经验证」的风险；
 *   单用户场景下抽取一次通常只产生 1~5 条记忆，
 *   batch=1 的吞吐损失可忽略，但彻底消除顺序对齐风险。
 */
export async function embed(text: string): Promise<number[]> {
  const res = await request(text);
  return res;
}

/**
 * 逐个生成向量。返回与输入等长的数组，**顺序由我们控制**（逐条请求），
 * 因此不存在批量返回顺序对齐的问题。
 *
 * 单条失败不抛错，而是在对应位置返回 null ——
 * 让调用方决定如何处理（通常是标记该记忆的 embedding 为 failed，
 * 记忆本身仍然保留，靠关键词通道降级可召回）。
 */
export async function embedMany(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = [];

  for (const text of texts) {
    try {
      results.push(await request(text));
    } catch {
      results.push(null);
    }
  }

  return results;
}

async function request(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${env.EMBEDDING_BASE_URL}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: text }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new EmbeddingError(
      `Embedding 服务请求失败（${env.EMBEDDING_BASE_URL}）：` +
        `${err instanceof Error ? err.message : String(err)}`,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new EmbeddingError(`Embedding 服务返回 ${res.status}`, {
      retryable: res.status >= 500 || res.status === 429,
      status: res.status,
    });
  }

  const json = (await res.json()) as number[][];
  const vec = json[0];

  if (!vec) {
    throw new EmbeddingError('Embedding 服务返回空数组', { retryable: true });
  }

  // 维度不符会导致写入被数据库拒绝（VECTOR(1024)），
  // 或更糟：若将来列类型变了则静默失配。这里明确报错。
  if (vec.length !== EMBEDDING_DIM) {
    throw new EmbeddingError(
      `向量维度 ${vec.length} 与冻结值 ${EMBEDDING_DIM} 不一致。` +
        `Schema 用的是 VECTOR(${EMBEDDING_DIM})（docs/03 §4.2），必须一致。`,
      { retryable: false }
    );
  }

  return vec;
}

/** 当前使用的模型标识，供写入 memory_embeddings.model 使用（单一常量，§14.5 C27） */
export const embeddingModelId = EMBEDDING_MODEL_ID;

/** 当前使用模型的维度 */
export const embeddingDimensions = EMBEDDING_DIM;

/**
 * 把向量数组转成 pgvector 字面量，形如 `[0.1,0.2,...]`。
 *
 * 【为什么放在这里，而不是各处自己写一份】
 *   写入（抽取流水线）与查询（检索）必须产出一致的字面量格式 ——
 *   两者一旦漂移，向量仍然能存进去、查询也不报错，
 *   但相似度会静默算错。这类「不报错的错误」只能靠单一实现来避免。
 *
 * 固定 7 位小数：精度远超实际需要（bge-m3 本身是 float32），
 * 同时避免浮点 toString 产生 `0.30000000000000004` 这类超长表示
 * 显著增大 SQL 体积。
 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((x) => x.toFixed(7)).join(',')}]`;
}
