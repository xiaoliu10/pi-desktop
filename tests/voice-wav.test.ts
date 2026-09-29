import { describe, expect, it } from 'vitest';
import { encodeWav16kMono, WAV_TARGET_RATE } from '../src/shared/voice-wav';

function readWavHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (o: number, n: number) => String.fromCharCode(...Array.from(bytes.slice(o, o + n)).map(c => c));
  return {
    riff: ascii(0, 4), wave: ascii(8, 4),
    pcm: view.getUint16(20, true), channels: view.getUint16(22, true),
    rate: view.getUint32(24, true), bits: view.getUint16(34, true),
    dataLength: view.getUint32(40, true),
  };
}

describe('16k 单声道 WAV 编码（上传前统一转码）', () => {
  it('立体声 44.1k 输入降为 16k 单声道 16-bit PCM，长度按重采样计', () => {
    const rate = 44_100;
    const left = new Float32Array(rate); // 1 秒
    const right = new Float32Array(rate).fill(0.5);
    for (let i = 0; i < rate; i++) left[i] = Math.sin(i / 10);
    const wav = encodeWav16kMono([left, right], rate);
    const h = readWavHeader(wav);
    expect(h.riff).toBe('RIFF'); expect(h.wave).toBe('WAVE');
    expect(h.pcm).toBe(1); expect(h.channels).toBe(1); expect(h.bits).toBe(16);
    expect(h.rate).toBe(WAV_TARGET_RATE);
    expect(h.dataLength).toBe(16_000 * 2); // 1 秒 @16k mono 16-bit
    expect(wav.length).toBe(44 + h.dataLength);
  });
  it('已经是 16k 的输入不做重采样，采样值被钳制到 [-1,1]', () => {
    const mono = new Float32Array([0, 0.25, 2, -2, -0.5]);
    const wav = encodeWav16kMono([mono], 16_000);
    const view = new DataView(wav.buffer);
    const samples = [0, 1, 2, 3, 4].map(i => view.getInt16(44 + i * 2, true) / 0x7fff);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(0.25, 2);
    expect(samples[2]).toBe(1);      // 钳制
    expect(samples[3]).toBeCloseTo(-1, 3); // 钳制（16 位有符号非对称，-32768/32767≈-1.00003）
    expect(samples[4]).toBeCloseTo(-0.5, 2);
  });
  it('空输入产出合法的空 WAV 头', () => {
    const wav = encodeWav16kMono([], 44_100);
    const h = readWavHeader(wav);
    expect(h.rate).toBe(WAV_TARGET_RATE);
    expect(h.dataLength).toBe(0);
  });
});
