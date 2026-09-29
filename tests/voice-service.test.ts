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

    expect(text).toEqual({ text: '你好世界' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new VoiceService(() => root).config().models[0].style).toBe('transcriptions');
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

  it('404 → Chat 成功：保留请求参数，保存方式、提示用户，后续直接走 Chat', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('<html>not found</html>', { status: 404 }))
      .mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '转写成功' } }] })));
    const svc = new VoiceService(() => root, fetchImpl);
    const cfg = svc.saveModel({ name: 'mimo', endpoint: 'https://gateway.example/v1/', model: 'asr-model', language: 'zh', apiKey: 'synthetic-secret', style: 'transcriptions' });
    const result = await svc.transcribe(new Uint8Array([1, 2, 3]), 'audio/wav');
    expect(result.text).toBe('转写成功');
    expect(result.notice).toMatch(/未提供 \/audio\/transcriptions.*404.*自动切换为 Chat 多模态.*已保存/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://gateway.example/v1/audio/transcriptions');
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://gateway.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer synthetic-secret');
    expect(JSON.parse(init.body)).toEqual({
      model: 'asr-model', asr_options: { language: 'zh' },
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AQID' } }] }],
    });
    expect(svc.config().models[0]).toEqual({ ...cfg.models[0], style: 'chat' });
    const restarted = new VoiceService(() => root, fetchImpl);
    expect(restarted.config().models[0].style).toBe('chat');
    expect(await restarted.transcribe(new Uint8Array([1]), 'audio/wav')).toEqual({ text: '转写成功' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2][0]).toBe('https://gateway.example/v1/chat/completions');
  });

  it.each([400, 401, 403, 429, 500])('transcriptions HTTP %i 不回退、不修改配置', async status => {
    const fetchImpl = vi.fn(async () => new Response('rejected synthetic-secret', { status }));
    const svc = new VoiceService(() => root, fetchImpl);
    svc.saveModel({ name: 'mock', model: 'mock', apiKey: 'synthetic-secret' });
    const error = await svc.transcribe(new Uint8Array([1]), 'audio/wav').catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(String(status));
    expect(String(error)).not.toContain('synthetic-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(svc.config().models[0].style).toBe('transcriptions');
  });

  it.each([400, 401, 404, 500])('404 → Chat HTTP %i 失败：同时说明两次状态、操作指引，不泄露密钥', async status => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('rejected synthetic-secret', { status }));
    const svc = new VoiceService(() => root, fetchImpl);
    svc.saveModel({ name: 'mock', model: 'mock', apiKey: 'synthetic-secret' });
    const error = await svc.transcribe(new Uint8Array([1]), 'audio/wav').catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/audio\/transcriptions 返回 404.*chat\/completions/);
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(String(error)).toContain('设置 → 语音输入');
    expect(String(error)).not.toContain('synthetic-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new VoiceService(() => root).config().models[0].style).toBe('transcriptions');
  });

  it('404 → Chat 网络失败仍包含两次状态，且不泄露异常中的密钥', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockRejectedValueOnce(new Error('network failure synthetic-secret'));
    const svc = new VoiceService(() => root, fetchImpl);
    svc.saveModel({ name: 'mock', model: 'mock', apiKey: 'synthetic-secret' });
    const error = await svc.transcribe(new Uint8Array([1]), 'audio/wav').catch(e => e as Error);
    expect(String(error)).toMatch(/audio\/transcriptions 返回 404.*未收到 HTTP 响应.*network failure/);
    expect(String(error)).not.toContain('synthetic-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['edit', 'remove', 'activate'] as const)('兼容请求期间 %s 不覆盖新配置或改变生效模型', async action => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockImplementationOnce(async () => {
        if (action === 'edit') svc.saveModel({ id, style: 'transcriptions', model: 'new-model' });
        if (action === 'remove') svc.removeModel(id);
        if (action === 'activate') svc.setActive(otherId);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    const svc = new VoiceService(() => root, fetchImpl);
    const id = svc.saveModel({ name: 'mock', model: 'mock', apiKey: 'synthetic-secret' }).activeId!;
    const otherId = svc.saveModel({ name: 'other', model: 'other', apiKey: 'other-secret' }).models[1].id;
    const result = await svc.transcribe(new Uint8Array([1]), 'audio/wav');
    expect(result.text).toBe('ok');
    if (action === 'activate') {
      expect(svc.config().activeId).toBe(otherId);
      expect(svc.config().models.find(m => m.id === id)?.style).toBe('chat');
      expect(svc.config().models.find(m => m.id === otherId)?.style).toBe('transcriptions');
    } else {
      expect(result.notice).toContain('未覆盖当前设置');
      expect(svc.config().models.find(m => m.id === id)).toEqual(action === 'remove' ? undefined : expect.objectContaining({ model: 'new-model', style: 'transcriptions' }));
    }
  });

  it('404 = 网关未实现转写端点：报可操作指引而非回显 HTML', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'mimo', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-asr', apiKey: 'sk' });
    const openresty = '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>openresty</center></body></html>';
    const fetchImpl = vi.fn(async () => new Response(openresty, { status: 404 }));
    await expect(new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/webm'))
      .rejects.toThrow(/audio\/transcriptions 返回 404.*chat\/completions.*HTTP 404.*设置/s);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('chat 方式（MiMo）：走 chat/completions，input_audio data URL + asr_options，文本取 message.content', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'MiMo ASR', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-asr', language: 'zh', style: 'chat', apiKey: 'sk' });
    let seen: { url: string; body: Record<string, unknown>; auth: string } | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '帮我修这个报错' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const text = await new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1, 2, 3]), 'audio/wav');
    expect(text).toEqual({ text: '帮我修这个报错' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen!.url).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    expect(seen!.auth).toBe('Bearer sk');
    const content = (seen!.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content[0];
    expect(content.type).toBe('input_audio');
    expect((content.input_audio as { data: string }).data).toMatch(/^data:audio\/wav;base64,/);
    expect(seen!.body.model).toBe('mimo-v2.5-asr');
    expect(seen!.body.asr_options).toEqual({ language: 'zh' });
  });

  it('chat 方式 content 为分段数组时拼接 text；语言留空回 auto', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'MiMo', endpoint: 'https://m.example.com/v1', model: 'mimo-v2.5-asr', style: 'chat', apiKey: 'sk' });
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const text = await new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/wav');
    expect(text).toEqual({ text: '第一段第二段' });
    expect((body!.asr_options as { language: string }).language).toBe('auto');
  });

  it('chat 方式 404 指引指向 chat/completions 并提示切换调用方式', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'm', endpoint: 'https://x.example.com/v1', model: 'asr', style: 'chat', apiKey: 'sk' });
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/wav'))
      .rejects.toThrow(/chat\/completions.*切换为 Chat 多模态/s);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new VoiceService(() => root).config().models[0].style).toBe('chat');
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

  it('404 → Chat 响应体超时仍保留两次 HTTP 状态且不保存方式', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response('missing', { status: 404 }))
        .mockImplementationOnce(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
          start(controller) {
            init.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        }), { status: 200 }));
      const svc = new VoiceService(() => root, fetchImpl);
      svc.saveModel({ name: 'mock', model: 'mock', apiKey: 'synthetic-secret' });
      const result = expect(svc.transcribe(new Uint8Array([1]), 'audio/wav'))
        .rejects.toThrow(/audio\/transcriptions 返回 404.*chat\/completions.*HTTP 200.*转写超时/);
      await vi.advanceTimersByTimeAsync(120_000);
      await result;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(svc.config().models[0].style).toBe('transcriptions');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('Chat 成功但落盘失败时保留转写文本并明确提示手动保存', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    const svc = new VoiceService(() => root, fetchImpl);
    svc.saveModel({ name: 'mock', model: 'mock', apiKey: 'synthetic-secret' });
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk full'); });
    try {
      const result = await svc.transcribe(new Uint8Array([1]), 'audio/wav');
      expect(result.text).toBe('ok');
      expect(result.notice).toContain('保存调用方式失败');
      expect(svc.config().models[0].style).toBe('transcriptions');
    } finally { write.mockRestore(); }
  });

  it('空结果按错误处理', async () => {
    const svc = new VoiceService(() => root);
    svc.saveModel({ name: 'x', model: 'whisper-1', apiKey: 'sk' });
    const fetchImpl = vi.fn(async () => new Response('{"text":"   "}', { status: 200 }));
    await expect(new VoiceService(() => root, fetchImpl as never).transcribe(new Uint8Array([1]), 'audio/webm'))
      .rejects.toThrow(/为空/);
  });
});
