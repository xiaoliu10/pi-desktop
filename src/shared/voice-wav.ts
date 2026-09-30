/**
 * 16 kHz 单声道 16-bit PCM WAV 编码（纯函数）。
 *
 * MediaRecorder 产出的 webm/opus 只有部分转写服务接受（MiMo ASR 等只收 wav/mp3），
 * 上传前统一转码为 WAV——wav 对 OpenAI transcriptions 与 chat 多模态端点都兼容。
 * 输入是 decodeAudioData 解出的各声道 PCM（-1..1 Float32），重采样用线性插值，
 * 对 ASR 场景足够。
 */

export const WAV_TARGET_RATE = 16_000;

export function encodeWav16kMono(channels: Float32Array[], sampleRate: number): Uint8Array {
  const valid = channels.filter(c => c && c.length);
  const mono = downmix(valid.length ? valid : [new Float32Array(0)]);
  const resampled = sampleRate === WAV_TARGET_RATE ? mono : resampleLinear(mono, sampleRate, WAV_TARGET_RATE);
  const dataLength = resampled.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, WAV_TARGET_RATE, true);
  view.setUint32(28, WAV_TARGET_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < resampled.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, resampled[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const length = Math.max(...channels.map(c => c.length));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const c of channels) sum += c[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (!input.length || from <= 0 || to <= 0) return new Float32Array(0);
  const ratio = from / to;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = (input[left] ?? 0) * (1 - frac) + (input[right] ?? 0) * frac;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
