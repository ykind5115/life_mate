/**
 * WAV 解析（只读我们需要的两件事：格式是否可用、时长）
 *
 * 【为什么自己解析而不是引依赖】
 *   前端上传的是**我们自己在浏览器里转好的 WAV**（见 public/recorder.js），
 *   格式固定：RIFF/WAVE、PCM、16kHz、单声道、16bit。
 *   要判断的东西只有两件：
 *     ① 它是不是一个能用的 WAV（不是的话直接拒绝，别送给 Whisper 猜）
 *     ② 它有多长（用来挡「录了 20 分钟」这种请求）
 *
 *   为一个 40 行的解析引一个音频库，与这个项目「能不加依赖就不加」
 *   的取向不符。而且自己解析能把错误话说清楚 ——
 *   引库只能得到一句 "Invalid file"。
 *
 * 【只支持我们产出的那种 WAV，不做通用解析器】
 *   刻意不支持带额外 chunk 的变体、不支持浮点采样、不支持多声道。
 *   遇到不认识的形态就明确报错，而不是尽力猜测 ——
 *   猜错会让 Whisper 拿到一段噪音然后吐出一串幻觉文本。
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 数据块字节数 */
  dataBytes: number;
  /** 时长（秒） */
  durationSeconds: number;
}

export class WavParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavParseError';
  }
}

/**
 * 解析 WAV 头。
 *
 * RIFF 结构：
 *   偏移 0   "RIFF"  <4字节总长>  "WAVE"
 *   之后是一串 chunk，每个是 <4字节ID><4字节长度><数据>
 *   我们找 "fmt " 与 "data" 两个 chunk。
 */
export function parseWav(buffer: Buffer): WavInfo {
  // 最小长度：12 字节 RIFF 头 + 8 字节 fmt 头 + 16 字节 fmt + 8 字节 data 头
  if (buffer.length < 44) {
    throw new WavParseError('音频太短，不是一个完整的 WAV 文件');
  }

  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new WavParseError('音频不是 RIFF/WAV 格式');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavParseError('音频不是 WAVE 格式');
  }

  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number; audioFormat: number } | null =
    null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || body + 16 > buffer.length) {
        throw new WavParseError('WAV 的 fmt 块不完整');
      }
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      // data chunk 的长度可能大于实际剩余字节（截断的文件），取两者较小值
      dataBytes = Math.min(chunkSize, buffer.length - body);
    }

    // chunk 长度为奇数时后面有一个填充字节
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new WavParseError('WAV 里没有 fmt 块，无法判断格式');
  if (dataBytes === null) throw new WavParseError('WAV 里没有 data 块，没有音频内容');

  /**
   * audioFormat 1 = PCM。不接受的三种情况都明确报出来：
   *   非 PCM、声道数异常、采样率异常 —— 这三种都会让 Whisper 拿到
   *   它没预期的输入，结果是一串看着像文本的幻觉。
   */
  if (fmt.audioFormat !== 1) {
    throw new WavParseError(`只支持未压缩的 PCM WAV（当前格式码 ${fmt.audioFormat}）`);
  }
  if (fmt.channels < 1 || fmt.channels > 2) {
    throw new WavParseError(`声道数 ${fmt.channels} 不支持（只支持单声道或立体声）`);
  }
  if (fmt.sampleRate < 8000 || fmt.sampleRate > 48000) {
    throw new WavParseError(`采样率 ${fmt.sampleRate}Hz 不合理`);
  }
  if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 8) {
    throw new WavParseError(`位深 ${fmt.bitsPerSample} 不支持（只支持 8 或 16 位）`);
  }

  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  const durationSeconds = bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0;

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataBytes,
    durationSeconds,
  };
}

/**
 * 把 Float32 音频转成 16kHz 单声道 16bit PCM 的 WAV。
 *
 * ⚠️ 这个函数**当前不在服务端使用** —— 浏览器侧已经转好了
 *    （public/recorder.js 用 OfflineAudioContext 做重采样）。
 *    留在这里是作为**测试夹具**：测试要构造合法的 WAV 来喂路由，
 *    手写字节数组既难读又容易写错。
 */
export function encodeWav16kMono(samples: Float32Array, sampleRate = 16_000): Buffer {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');

  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt 块长度
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // 字节率
  buffer.writeUInt16LE(2, 32); // 块对齐
  buffer.writeUInt16LE(16, 34); // 位深

  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < numSamples; i++) {
    // 钳到 [-1, 1] 再量化 —— 越界会让 16bit 溢出成噪音
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  return buffer;
}
