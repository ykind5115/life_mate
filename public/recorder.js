/**
 * 录音 + 转成 16kHz 单声道 WAV（浏览器侧）
 *
 * 【为什么在浏览器里转换，而不是在服务端用 ffmpeg】
 *   MediaRecorder 在 Chrome/Edge 上给的是 webm/opus，
 *   而 Whisper 期望 WAV/PCM。
 *
 *   两条路：
 *     ① 服务端装 ffmpeg 转 —— 多一个系统依赖，多一层失败可能
 *     ② 浏览器用 Web Audio API 重采样 —— 零依赖，且**转换逻辑与录制的
 *        采样率无关**（浏览器给什么都能归一到 16kHz）
 *
 *   选 ②。理由不只是「省一个依赖」：这条路把「格式归一」放在了
 *   数据产生的地方，服务端因此只需要处理一种确定的输入 ——
 *   而服务端代码越少假设，越不容易在别人换个浏览器时坏掉。
 *
 * 【16kHz 单声道是 Whisper 的原生输入】
 *   送别的采样率它内部也要重采样，不如我们一次做对：
 *   带宽还小（16kHz × 16bit = 32KB/s，5 分钟约 9.6MB）。
 *
 * ⚠️ 本文件是**无构建步骤**的浏览器模块：不能出现 TypeScript 语法
 *    （类型标注、export interface…）。`node --check` 会直接报语法错。
 *    这个错我在 core.js 上已经犯过一次，这里又犯了一次 ——
 *    加注释时顺手写成 TS 类型是很自然的事，
 *    因此提交前必须跑一遍 `node --check public/*.js`。
 */

/** MediaRecorder 的候选 MIME。按优先级挑浏览器支持的那个 */
const CANDIDATE_MIME = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export class RecorderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecorderError';
  }
}

/**
 * 请求麦克风并开始录音。
 *
 * 返回 `{ stop, cancel, elapsedMs }`：
 *   stop()      停止录音，返回 16kHz 单声道 WAV 的 Blob（没录到内容时为 null）
 *   cancel()    放弃这次录音，不产出任何东西
 *   elapsedMs() 已经录了多久
 *
 * ⚠️ 权限请求必须在**用户手势**里发生（点按钮），
 *    否则浏览器会直接拒绝或静默失败。
 */
export async function startRecording() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new RecorderError('这个浏览器不支持录音（需要 MediaRecorder 与 getUserMedia）');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        /**
         * 关掉浏览器的自动处理：它们是给「通话」优化的，
         * 而我们要的是尽量接近用户真实说的话。
         * 回声消除尤其有害 —— 它会把安静的停顿压掉，
         * 而 Whisper 靠那些停顿断句。
         */
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    // 把浏览器的原始错误翻成人话 —— 用户需要知道去改哪个开关
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError') {
      throw new RecorderError('麦克风权限被拒绝了。要在浏览器地址栏左侧的图标里允许麦克风，然后刷新页面。');
    }
    if (name === 'NotFoundError') {
      throw new RecorderError('没有找到麦克风设备。');
    }
    throw new RecorderError(`打不开麦克风：${err instanceof Error ? err.message : String(err)}`);
  }

  const mimeType = CANDIDATE_MIME.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) {
    stream.getTracks().forEach((t) => t.stop());
    throw new RecorderError('这个浏览器没有可用的录音编码格式');
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  const startedAt = Date.now();

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.start();

  /** 释放麦克风。不做的话浏览器标签页会一直显示「正在录音」 */
  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
  };

  return {
    elapsedMs: () => Date.now() - startedAt,

    cancel: () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* 已经停了就算了 */
      }
      release();
    },

    stop: async () => {
      const blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
        try {
          recorder.stop();
        } catch {
          resolve(new Blob(chunks, { type: mimeType }));
        }
      });

      release();

      if (blob.size === 0) return null;
      return toWav16kMono(blob);
    },
  };
}

/**
 * 把任意格式的音频 Blob 转成 16kHz 单声道 16bit WAV。
 *
 * 用 OfflineAudioContext 做重采样：它比手写线性插值准确
 * （浏览器内部用的是带抗混叠滤波的重采样），而且代码短得多。
 */
export async function toWav16kMono(input, targetRate = 16_000) {
  const arrayBuffer = await input.arrayBuffer();

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new RecorderError('这个浏览器不支持 Web Audio API');

  // 先解码成 PCM。decodeAudioData 会吃掉原始容器（webm/ogg/mp4 都认）
  const probeCtx = new AudioCtx();
  let decoded;
  try {
    decoded = await probeCtx.decodeAudioData(arrayBuffer);
  } catch {
    throw new RecorderError('录到的音频解不开 —— 可能是录音被中途打断');
  } finally {
    void probeCtx.close();
  }

  // 重采样到 16kHz，并混成单声道
  const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineCtx(1, frameCount, targetRate);

  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();

  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  return encodeWav(samples, targetRate);
}

/**
 * Float32 采样 → 16bit PCM 的 WAV Blob。
 *
 * 与 src/shared/wav.ts 的 encodeWav16kMono 是同一件事的两份实现 ——
 * 那份在 Node 侧（测试夹具用），这份在浏览器侧（真实录音用）。
 * 刻意不共享：两边运行时不同，硬要共用就得引入构建步骤或
 * 让服务端代码进浏览器包，代价大于这 30 行重复。
 * 两者的字节布局必须一致 —— 由服务端的 parseWav 测试守住。
 */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深

  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    // 钳到 [-1, 1]：越界会让 16bit 溢出成噪音
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
