/**
 * 语音转文字客户端（本地 Whisper 服务）
 *
 * 依据：docs/17 §3
 *
 * 【分层位置】
 *   与 llm/embedding.ts 平级：都是「外部服务客户端」，不是业务逻辑。
 *   routes/transcribe.ts 只做校验与协议转换，真正的 HTTP 调用在这里。
 *
 * 【为什么是本地部署】
 *   语音是「不经过键盘的真心话」，往往比打字更私密 ——
 *   记忆里已经全是前女友、工资、面试、加班吐槽这类事。
 *   浏览器自带的 Web Speech API 在中文下依赖服务端识别，
 *   音频确实会离开这台机器，因此不用。
 *
 * 【这一层不落库】
 *   转写结果是**输入草稿**，不是内容：
 *   它要经过用户确认才会变成一条消息（走现有的 POST /chat/stream），
 *   而「记住什么」由抽取流水线按原有规则决定。
 *   所以这里既不写 messages 也不写 memories ——
 *   用户要的「不需要改造现有记忆系统」就是靠这一点成立的。
 *
 * 【日志纪律】§29.1 禁止记录正文。
 *   转写出的文本与用户消息正文同级，**绝不能进日志**。
 *   本文件只记时长、字节数、耗时这类数字。
 */
import { env } from '../shared/env.js';

/**
 * 转写超时。取 env，不在本文件另写常量 ——
 * 那会让 .env 里的配置变成摆设（embedding.ts 记过同一个教训）。
 */
const timeoutMs = env.STT_TIMEOUT_MS;

export class SttError extends Error {
  constructor(
    message: string,
    readonly options: { retryable: boolean; status?: number } = { retryable: true }
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export interface TranscribeResult {
  /** 转写出的文本。**不要打进日志** */
  text: string;
  /** 服务端报告的音频时长（秒）。拿不到时为 null */
  durationSeconds: number | null;
  /** 实际使用的模型标识 */
  model: string;
  /** 转写耗时（ms），用于观测 */
  elapsedMs: number;
}

/**
 * 把一段音频转成文字。
 *
 * @param audio      音频字节。**推荐 16kHz 单声道 WAV** ——
 *                   浏览器侧已经转好（见 public/recorder.js 的说明），
 *                   因此服务端不需要 ffmpeg。
 * @param filename   带扩展名的文件名。Whisper 服务按扩展名判断容器格式，
 *                   因此这个名字必须反映**真实格式**，不能随便写。
 * @param signal     请求级取消信号（客户端断开时中止，避免白占 GPU）
 */
export async function transcribeAudio(params: {
  audio: Buffer;
  filename: string;
  signal?: AbortSignal;
}): Promise<TranscribeResult> {
  const startedAt = Date.now();

  const form = new FormData();
  form.append(
    'audio_file',
    new Blob([new Uint8Array(params.audio)], { type: contentTypeFor(params.filename) }),
    params.filename
  );
  /**
   * output=json 让服务返回结构化结果（含时长）。
   * language=zh 显式指定中文 —— 不指定时 Whisper 会先做语种检测，
   * 对短音频容易判断错（几秒钟的「嗯」「好」可能被识别成日文或韩文）。
   */
  form.append('output', 'json');
  form.append('language', 'zh');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 把调用方的取消信号并进来：客户端断开时不该继续占着 GPU
  params.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(`${env.STT_BASE_URL}/asr?output=json&language=zh`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new SttError(
      aborted
        ? `语音转文字超时（超过 ${timeoutMs}ms）。录音较长时首次调用会因为模型加载更慢，可以再试一次。`
        : `语音转文字服务连不上（${env.STT_BASE_URL}）：` +
            `${err instanceof Error ? err.message : String(err)}`,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    /**
     * ⚠️ 不要把服务端返回的正文原样抛出去 ——
     *    某些实现会在错误信息里带上请求内容（也就是用户说的话）。
     *    只保留状态码，由上层给出人话。
     */
    throw new SttError(`语音转文字服务返回 ${res.status}`, {
      retryable: res.status >= 500 || res.status === 429,
      status: res.status,
    });
  }

  const json = (await res.json()) as { text?: unknown; duration?: unknown; segments?: unknown };

  /**
   * 容错地取文本。不同实现的字段名不完全一致
   * （text / transcription），这里两种都认，但不猜更多 ——
   * 猜错会静默返回空字符串，那比报错更难查。
   */
  const text = typeof json.text === 'string' ? json.text : null;
  if (text === null) {
    throw new SttError('语音转文字服务返回了无法识别的结构（没有 text 字段）', {
      retryable: false,
    });
  }

  const duration =
    typeof json.duration === 'number' && Number.isFinite(json.duration) ? json.duration : null;

  return {
    text: text.trim(),
    durationSeconds: duration,
    model: env.STT_MODEL,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 按扩展名给出 MIME 类型。Whisper 服务主要看扩展名，这个只是配合 */
function contentTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

/**
 * 服务可达性探测（健康检查用）。
 *
 * 与 embedding 一样：探不通不该让整个应用起不来 ——
 * 语音只是**可选的输入方式**，它挂了打字照样能用。
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
