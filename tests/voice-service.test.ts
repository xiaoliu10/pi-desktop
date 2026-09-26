import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// secrets.ts 依赖 electron safeStorage；测试环境用明文回退路径。
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b,
  },
}));

import { VoiceService } from '../src/main/pi/voice-service';
import { VOICE_MAX_BYTES } from '../src/shared/voice';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-voice-'));
}

describe('VoiceService 模型列表', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('初始为空：models=[]、activeId=null，不落盘', () => {
    const svc = new VoiceService(() => root);
    const cfg = svc.config();
    expect(cfg.models).toEqual([]);
    expect(cfg.activeId).toBeNull();
    expect(fs.existsSync(path.join(root, 'voice.json'))).toBe(false);
  });

  it('未配置任何就绪模型 = 语音输入未开启（门槛判定）', () => {
    const svc = new VoiceService(() => root);
    expect(svc.config().models.some(m => m.ready)).toBe(false);
    // 只有名称和模型、没有 key 的模型也不算就绪
    svc.saveModel({ name: 'no-key', model: 'whisper-1' });
    expect(svc.config().models.some(m => m.ready)).toBe(false);
    // 补上 key 后才算就绪
    svc.saveModel({ id: svc.config().models[0].id, name: 'no-key', model: 'whisper-1', apiKey: 'sk-x' });
    expect(svc.config().models.some(m => m.ready)).toBe(true);
  });

  it('新增后自动设为生效，回视不含密钥明文', () => {
    const svc = new VoiceService(() => root);
    const cfg = svc.saveModel({ name: 'OpenAI whisper', endpoint: 'https://api.example.com/v1/', model: 'whisper-1', language: 'zh', apiKey: 'sk-secret-123' });
    expect(cfg.models).toHaveLength(1);
    expect(cfg.activeId).toBe(cfg.models[0].id);
    expect(cfg.models[0]).toMatchObject({ name: 'OpenAI whisper', endpoint: 'https://api.example.com/v1/', model: 'whisper-1', language: 'zh', hasKey: true, ready: true });
    expect(JSON.stringify(cfg)).not.toContain('sk-secret-123');
    const raw = fs.readFileSync(path.join(root, 'voice.json'), 'utf8');
    expect(raw).not.toContain('sk-secret-123');
  });

  it('可配置多个模型并切换生效；删除生效模型回退到第一个', () => {
    const svc = new VoiceService(() => root);
    const a = svc.saveModel({ name: 'A', model: 'whisper-1', apiKey: 'sk-a' });
    const b = svc.saveModel({ name: 'B', endpoint: 'https://b.example.com/v1', model: 'paraformer', apiKey: 'sk-b' });
    expect(b.models).toHaveLength(2);
    expect(b.activeId).toBe(a.models[0].id); // 首个保持生效

    const switched = svc.setActive(b.models[1].id);
    expect(switched.activeId).toBe(b.models[1].id);

    const removed = svc.removeModel(b.models[1].id);
    expect(removed.models).toHaveLength(1);
    expect(removed.activeId).toBe(a.models[0].id);
  });

  it('setActive 指向不存在的模型报错', () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'A', model: 'whisper-1', apiKey: 'sk' });
    expect(() => svc.setActive('nope')).toThrow(/不存在/);
  });

  it('编辑时 apiKey 缺省保持不变；空串清除', () => {
    const svc = new VoiceService(() => root);
    const first = svc.saveModel({ name: 'keep', model: 'whisper-1', apiKey: 'sk-keep' });
    const id = first.models[0].id;
    expect(svc.saveModel({ id, name: 'keep', model: 'whisper-1' }).models[0].hasKey).toBe(true);
    expect(svc.saveModel({ id, name: 'keep', model: 'whisper-1', apiKey: '' }).models[0].hasKey).toBe(false);
  });

  it('校验：缺名称/模型 ID 拒绝；非 http(s) 端点拒绝', () => {
    const svc = new VoiceService(() => root);
    expect(() => svc.saveModel({ model: 'whisper-1' })).toThrow(/名称/);
    expect(() => svc.saveModel({ name: 'x' })).toThrow(/模型 ID/);
    expect(() => svc.saveModel({ name: 'x', model: 'm', endpoint: 'ftp://nope' })).toThrow(/http/);
  });

  it('旧单配置形态（endpoint/model/language/apiKey）迁移为第一个模型', () => {
    fs.writeFileSync(path.join(root, 'voice.json'), JSON.stringify({
      endpoint: 'https://legacy.example.com/v1',
      model: 'whisper-1',
      language: 'zh',
      apiKey: 'sk-legacy',
    }), 'utf8');
    const svc = new VoiceService(() => root);
    const cfg = svc.config();
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0]).toMatchObject({ name: '默认转写模型', endpoint: 'https://legacy.example.com/v1', language: 'zh', ready: true });
    expect(cfg.activeId).toBe(cfg.models[0].id);
  });

  it('损坏的 voice.json 按未配置处理', () => {
    fs.writeFileSync(path.join(root, 'voice.json'), '{oops', 'utf8');
    const svc = new VoiceService(() => root);
    expect(svc.config().models).toEqual([]);
  });
});

describe('VoiceService 转写', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('未配置模型时直接报错，不发请求', async () => {
    const fetchImpl = vi.fn();
    const svc = new VoiceService(() => root, fetchImpl as never);
    await expect(svc.transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(/ASR 模型/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('用生效模型构造 multipart 请求：Bearer 头、model/language 字段与文件名', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'OpenAI', endpoint: 'https://api.example.com/v1', model: 'whisper-1', language: 'zh', apiKey: 'sk-test' });

    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify({ text: '你好世界' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const text = await new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1, 2, 3]), 'audio/webm;codecs=opus');

    expect(text).toBe('你好世界');
    expect(seenUrl).toBe('https://api.example.com/v1/audio/transcriptions');
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const form = seenInit?.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('zh');
    const file = form.get('file') as File;
    expect(file.name).toBe('recording.webm');
  });

  it('切换生效模型后转写走新端点', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'A', endpoint: 'https://a.example.com/v1', model: 'whisper-1', apiKey: 'sk-a' });
    const second = svc.saveModel({ name: 'B', endpoint: 'https://b.example.com/v1', model: 'whisper-1', apiKey: 'sk-b' });
    svc.setActive(second.models[1].id);

    let seenUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return new Response('{"text":"x"}', { status: 200 });
    });
    await new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/webm');
    expect(seenUrl).toBe('https://b.example.com/v1/audio/transcriptions');
  });

  it('端点带尾斜杠时拼接不产生双斜杠', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'slash', endpoint: 'https://api.example.com/v1/', model: 'whisper-1', apiKey: 'sk' });
    let seenUrl = '';
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return new Response('{"text":"x"}', { status: 200 });
    });
    await new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/webm');
    expect(seenUrl).toBe('https://api.example.com/v1/audio/transcriptions');
  });

  it('非 2xx 响应带状态码报错', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'x', model: 'whisper-1', apiKey: 'sk' });
    const fetchImpl = vi.fn(async () => new Response('invalid api key', { status: 401 }));
    await expect(new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/webm'))
      .rejects.toThrow(/401/);
  });

  it('超过体积上限直接拒绝', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'x', model: 'whisper-1', apiKey: 'sk' });
    const fetchImpl = vi.fn();
    const huge = new Uint8Array(VOICE_MAX_BYTES + 1);
    await expect(new VoiceService(() => root, fetchImpl as never).transcribe(huge, 'audio/webm'))
      .rejects.toThrow(/MiB/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([200, 500])('响应头已到但 %i 响应体挂起仍超时', async status => {
    vi.useFakeTimers();
    try {
      const svc = new VoiceService(() => root, async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }), { status }));
      svc.saveModel({ name: 'mock', model: 'mock', apiKey: 'synthetic-key' });
      const result = expect(svc.transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow('转写超时');
      await vi.advanceTimersByTimeAsync(120_000);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('空结果按错误处理', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'x', model: 'whisper-1', apiKey: 'sk' });
    const fetchImpl = vi.fn(async () => new Response('{"text":"   "}', { status: 200 }));
    await expect(new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/webm'))
      .rejects.toThrow(/为空/);
  });
});
