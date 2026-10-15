/**
 * 语音转文字客户端（本地 Whisper 服务）
 *
 * 依据：docs/17 §3；接口形态**实测确认于 2026-10-13**
 *
 * 【分层位置】
 *   与 llm/embedding.ts 平级：都是「外部服务客户端」，不是业务逻辑。
 *
 * 【为什么是本地部署】
 *   语音是「不经过键盘的真心话」，往往比打字更私密 ——
 *   记忆里已经全是前女友、工资、面试、加班吐槽这类事。
 *   浏览器自带的 Web Speech API 在中文下依赖服务端识别，
 *   音频确实会离开这台机器，因此不用。
 *
 * 【这一层不落库】
 *   转写结果是**输入草稿**，不是内容：它要经过用户确认才会变成一条消息，
 *   而「记住什么」由抽取流水线按原有规则决定。
 *
 * 【日志纪律】§29.1 禁止记录正文。
 *   转写出的文本与用户消息正文同级，**绝不能进日志**。
 *
 * ══════════════════════════════════════════════════════════════
 * 实测确认的接口契约（2026-10-13）
 * 服务：onerahmet/openai-whisper-asr-webservice:latest-gpu
 * ══════════════════════════════════════════════════════════════
 *
 * ① 请求必须是 **multipart/form-data**，字段名 `audio_file`。
 *    我最初按文档猜的是「原始字节 + Content-Type」，实测被拒：
 *      HTTP 422 {"detail":[{"loc":["body","audio_file"],"msg":"Field required"}]}
 *
 * ② 查询参数（OpenAPI 实测）：output=json|txt|vtt|srt|tsv（默认 txt）、
 *    language=<ISO 639-1>（默认自动检测）、task=transcribe|translate、
 *    encode=bool（默认 true）、initial_prompt
 *
 * ③ 响应形状（output=json）：
 *      { text, language, segments: [
 *          { id, seek, start, end, text, tokens, temperature,
 *            avg_logprob, compression_ratio, no_speech_prob } ] }
 *    ⚠️ **没有 duration 字段** —— 顶层只有 text / segments / language。
 *       （我原来按 duration 取，会永远拿到 null。）
 *    ⚠️ Content-Type 是 text/plain，但内容是 JSON —— 不能按 content-type 判断。
 *
 * ④ 🔴 **Whisper 对非语音会编造内容，而且编得很「自信」。**
 *    实测（同一服务、同一参数）：
 *      静音 1 秒   → "优优独播剧场——YoYo Television Series Exclusive"
 *                     avg_logprob -0.153   ← 比真实语音还高
 *      静音 5 秒   → "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"
 *                     avg_logprob -0.099
 *      纯音 2 秒   → "字幕志愿者 杨茜茜"
 *      白噪声 2 秒 → " sacrifice"
 *      真实中文语音 → 逐字正确，avg_logprob -0.117 / -0.209
 *
 *    ⇒ 纯静音会被写成一句电视剧台词。用户没看清就发出去，
 *      它会进记忆抽取、变成一条假记忆。
 *
 * ⑤ 判据：`no_speech_prob` 与 `avg_logprob` **都不可用**
 *      · no_speech_prob 在所有情况下都是 1e-10 量级，完全无区分度
 *      · avg_logprob 在静音编造时是 -0.099（很「自信」），
 *        而真实语音说一个「嗯」是 -3.603 —— **两个方向都是反的**
 *
 *    可用的是**溢出比**：segments 的结束时间 ÷ 音频真实时长
 *      真实语音：0.5 ~ 0.8（永远 ≤ 1，说话不可能超出录音长度）
 *      静音 1 秒：29.98 / 1 = **30x**   ← Whisper 在 30 秒填充上编造
 *      静音 5 秒：29.98 / 5 = 6x
 *      纯音 / 噪声：1.0x（这个判据抓不到，见下）
 *
 *    ⚠️ 溢出比抓不到纯音与噪声那两种（它们恰好贴着 1.0x）。
 *      那两种只能靠用户确认那一步兜住 —— 这正是「不自动发送」
 *      这个设计存在的意义：不是为了礼貌，是为了防止垃圾进记忆。
 */
import { env } from '../shared/env.js';

const timeoutMs = env.STT_TIMEOUT_MS;

/**
 * 溢出比的上限。
 *
 * 真实语音实测 0.5~0.8，留到 2.5 是很宽的余量 ——
 * 这个判据只用来挡「明显不可能」的情况（静音编造 30x、6x），
 * 不是用来判断识别质量的。
 */
const MAX_OVER_RUN_RATIO = 2.5;

/**
 * 音频短于这个秒数就不送识别。
 *
 * 实测：1.16 秒的真实人声「嗯」被识别成 "ben"。
 * 更短的片段（点一下就停、环境噪音）几乎必然产出垃圾。
 * 与其让用户对着一句假文本发愣，不如直接说「太短了」。
 */
const MIN_AUDIO_SECONDS = 0.8;

/**
 * 失败的种类。**它决定返回给用户的状态码**，因此必须显式区分：
 *
 *   input       —— 这段音频不行（太短、格式不对）。重试没有意义，
 *                  要告诉用户改怎么做。→ 400
 *   unavailable —— 服务连不上 / 超时。等一会儿再试可能就好了。→ 503
 *   upstream    —— 服务收到了但拒绝了（它内部的错）。→ 400 + 服务端状态码
 *
 * ⚠️ 这个区分是实测逼出来的：最初把「太短」也扔进 unavailable，
 *    于是前端收到 503「服务暂不可用」—— 而重试一百次都一样，
 *    用户会以为是服务坏了，其实只是话说得太短。
 */
export type SttErrorKind = 'input' | 'unavailable' | 'upstream';

export class SttError extends Error {
  constructor(
    message: string,
    readonly options: {
      kind: SttErrorKind;
      /** 上游返回的 HTTP 状态码（kind='upstream' 时有值） */
      status?: number;
    }
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export interface TranscribeResult {
  /** 转写出的文本。**不要打进日志** */
  text: string;
  /** 识别出的语种（服务返回，可能与我们请求的不同） */
  language: string | null;
  /** 实际使用的模型标识（来自配置，服务本身不回报模型名） */
  model: string;
  /**
   * 结果是否可疑（疑似对非语音编造了文本）。
   *
   * 前端据此提示「这段可能不准，仔细核对一下」，
   * **但不阻止使用** —— 用户是最终判断者。
   */
  suspicious: boolean;
  /** 判定可疑的原因，用于提示与观测（不含正文） */
  suspicionReason: string | null;
  /** 转写耗时（ms） */
  elapsedMs: number;
}

/** 服务返回的 segment（只取我们用到的字段） */
interface AsrSegment {
  end?: unknown;
  avg_logprob?: unknown;
  no_speech_prob?: unknown;
  compression_ratio?: unknown;
}

/**
 * 把一段音频转成文字。
 *
 * @param audio        音频字节。**必须是 16kHz 单声道 WAV** ——
 *                     浏览器侧已经转好（见 public/recorder.js）。
 * @param audioSeconds 音频的真实时长（由我们自己解析 WAV 头得到）。
 *                     ⚠️ 用它做溢出比判据，**不信服务返回的时长** ——
 *                        因为它正是那个可能被编造出来的值。
 */
export async function transcribeAudio(params: {
  audio: Buffer;
  audioSeconds: number;
  filename?: string;
  signal?: AbortSignal;
}): Promise<TranscribeResult> {
  const startedAt = Date.now();

  // 太短就不送 —— 省掉一次 GPU 调用，也避免产出一句假文本
  if (params.audioSeconds < MIN_AUDIO_SECONDS) {
    throw new SttError(
      `这段录音只有 ${params.audioSeconds.toFixed(1)} 秒，太短了。说一句完整的话再试。`,
      // 这是**输入问题**，不是服务故障：重试没有意义
      { kind: 'input' }
    );
  }

  const form = new FormData();
  form.append(
    'audio_file',
    new Blob([new Uint8Array(params.audio)], { type: 'audio/wav' }),
    params.filename ?? 'speech.wav'
  );

  /**
   * language=zh 显式指定中文：不指定时服务会先做语种检测，
   * 短音频容易判错（可能识别成日文或韩文）。
   */
  const url = `${env.STT_BASE_URL}/asr?output=json&language=zh&task=transcribe`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  params.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new SttError(
      aborted
        ? `语音转文字超时（超过 ${timeoutMs}ms）。首次调用会加载模型、明显更慢，可以再试一次。`
        : `语音转文字服务连不上（${env.STT_BASE_URL}）：` +
            `${err instanceof Error ? err.message : String(err)}`,
      // 连不上/超时是**服务不可用**：等一会儿再试有意义
      { kind: 'unavailable' }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    /**
     * ⚠️ 不把服务端返回的正文原样抛出去 —— 某些实现会在错误信息里
     *    带上请求内容（也就是用户说的话）。只保留状态码。
     */
    throw new SttError(`语音转文字服务返回 ${res.status}`, {
      kind: 'upstream',
      status: res.status,
    });
  }

  // 服务返回 text/plain，内容其实是 JSON（实测）—— 直接当 JSON 解析
  const raw = await res.text();
  let json: { text?: unknown; language?: unknown; segments?: unknown };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new SttError('语音转文字服务返回的不是 JSON', { kind: 'upstream' });
  }

  const text = typeof json.text === 'string' ? json.text.trim() : null;
  if (text === null) {
    throw new SttError('语音转文字服务返回了无法识别的结构（没有 text 字段）', {
      kind: 'upstream',
    });
  }

  const language = typeof json.language === 'string' ? json.language : null;
  const segments = Array.isArray(json.segments) ? (json.segments as AsrSegment[]) : [];

  // 溢出比判据：最后一个 segment 的结束时间 ÷ 音频真实时长（见文件头实测表）
  let suspicious = false;
  let suspicionReason: string | null = null;

  const lastEnd = lastSegmentEnd(segments);
  if (lastEnd !== null && lastEnd > params.audioSeconds * MAX_OVER_RUN_RATIO) {
    suspicious = true;
    suspicionReason =
      `它报告的内容长度（${lastEnd.toFixed(1)}s）远超音频实际时长` +
      `（${params.audioSeconds.toFixed(1)}s），像是给非语音内容编了一段文本`;
  }

  return {
    text,
    language,
    model: env.STT_MODEL,
    suspicious,
    suspicionReason,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 取最后一个 segment 的 end（非数字则忽略） */
function lastSegmentEnd(segments: AsrSegment[]): number | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const end = segments[i]?.end;
    if (typeof end === 'number' && Number.isFinite(end)) return end;
  }
  return null;
}

/**
 * 服务可达性探测（前端用它决定要不要显示麦克风）。
 *
 * 探不通不该让整个应用起不来 —— 语音只是**可选的输入方式**。
 */
export async function probeStt(): Promise<boolean> {
  try {
    const res = await fetch(`${env.STT_BASE_URL}/docs`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
