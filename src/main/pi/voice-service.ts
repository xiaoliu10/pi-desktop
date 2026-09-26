import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../secrets';
import type { VoiceAsrModel, VoiceAsrModelInput, VoiceConfig } from '../../shared/voice';
import { VOICE_MAX_BYTES } from '../../shared/voice';

/**
 * 云端语音转写服务：ASR 模型列表（voice.json，密钥经 safeStorage 加密）
 * + 转写请求。只被主进程调用；renderer 拿到的 VoiceConfig 不含密钥明文。
 *
 * 开启语音输入的门槛 = 当前生效 ASR 模型 ready。
 */

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'whisper-1';
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** 落盘形态：单模型结构（旧版）或多模型结构（models + activeId）。 */
interface StoredModel {
  id: string;
  name?: string;
  endpoint?: string;
  model?: string;
  language?: string;
  /** encryptSecret 后的密文；空串 = 未配置。 */
  apiKey?: string;
}

interface StoredVoice {
  models: StoredModel[];
  activeId?: string | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** mime → 上传文件扩展名（OpenAI 兼容端点按扩展名/嗅探识别格式）。 */
const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};

function isValidEndpoint(endpoint: string): boolean {
  return /^https?:\/\/\S+$/i.test(endpoint);
}

export class VoiceService {
  private cached: StoredVoice | undefined;

  constructor(
    private readonly rootFn: () => string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private get file(): string {
    return path.join(this.rootFn(), 'voice.json');
  }

  private read(): StoredVoice {
    if (this.cached) return this.cached;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* 首次使用：文件不存在或损坏都按未配置处理，不阻塞启动。 */
      raw = undefined;
    }
    this.cached = normalizeStored(raw);
    return this.cached;
  }

  private write(value: StoredVoice): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(value, null, 2), 'utf8');
    this.cached = value;
  }

  /** 生效模型的存储视图；无模型或指向失效 id 时回退到第一个。 */
  private activeStored(): StoredModel | undefined {
    const stored = this.read();
    const hit = stored.models.find(m => m.id === stored.activeId);
    return hit ?? stored.models[0];
  }

  private viewModel(model: StoredModel): VoiceAsrModel {
    const endpoint = (model.endpoint ?? '').trim() || DEFAULT_ENDPOINT;
    const name = (model.name ?? '').trim() || model.model?.trim() || DEFAULT_MODEL;
    const modelId = (model.model ?? '').trim() || DEFAULT_MODEL;
    const hasKey = Boolean(model.apiKey && decryptSecret(model.apiKey));
    return {
      id: model.id,
      name,
      endpoint,
      model: modelId,
      language: (model.language ?? '').trim(),
      hasKey,
      ready: isValidEndpoint(endpoint) && Boolean(modelId) && hasKey,
    };
  }

  config(): VoiceConfig {
    const stored = this.read();
    const models = stored.models.map(m => this.viewModel(m));
    const active = this.activeStored();
    return { models, activeId: active ? active.id : null };
  }

  /**
   * 新增 / 更新一个 ASR 模型。input.id 存在且命中 = 更新，否则新增。
   * apiKey 缺省保持不变，空串清除。保存后若尚无生效模型则自动设为生效。
   */
  saveModel(input: VoiceAsrModelInput): ReturnType<VoiceService['config']> {
    const stored = { ...this.read(), models: [...this.read().models] };
    const existingIndex = input.id ? stored.models.findIndex(m => m.id === input.id) : -1;
    const current = existingIndex >= 0 ? stored.models[existingIndex] : undefined;

    const name = (input.name ?? current?.name ?? '').trim();
    const endpoint = (input.endpoint ?? current?.endpoint ?? '').trim();
    const modelId = (input.model ?? current?.model ?? '').trim();
    const language = (input.language ?? current?.language ?? '').trim();

    if (!name) throw new Error('请填写模型名称');
    if (!modelId) throw new Error('请填写转写模型 ID');
    if (endpoint && !isValidEndpoint(endpoint)) throw new Error('接口地址需以 http(s):// 开头');

    const next: StoredModel = { ...current, id: current?.id ?? randomUUID(), name, model: modelId, language };
    if (endpoint) next.endpoint = endpoint;
    if (typeof input.apiKey === 'string') {
      const key = input.apiKey.trim();
      next.apiKey = key ? encryptSecret(key) : '';
    } else if (current?.apiKey) {
      next.apiKey = current.apiKey;
    }

    if (existingIndex >= 0) stored.models.splice(existingIndex, 1, next);
    else stored.models.push(next);
    if (!stored.models.some(m => m.id === stored.activeId)) stored.activeId = next.id;
    this.write(stored);
    return this.config();
  }

  removeModel(id: string): ReturnType<VoiceService['config']> {
    const stored = { ...this.read(), models: this.read().models.filter(m => m.id !== id) };
    if (stored.activeId === id) stored.activeId = stored.models[0]?.id ?? null;
    this.write(stored);
    return this.config();
  }

  setActive(id: string): ReturnType<VoiceService['config']> {
    const stored = this.read();
    if (!stored.models.some(m => m.id === id)) throw new Error('模型不存在');
    this.write({ ...stored, activeId: id });
    return this.config();
  }

  /**
   * 用生效模型上传一段录音到 {endpoint}/audio/transcriptions，返回转写文本。
   * 密钥只在主进程解密并放进 Authorization 头。
   */
  async transcribe(bytes: Uint8Array, mime: string): Promise<string> {
    const active = this.activeStored();
    if (!active) throw new Error('尚未配置 ASR 模型，请到设置 → 语音输入至少添加一个模型');
    const cfg = this.viewModel(active);
    const apiKey = active.apiKey ? decryptSecret(active.apiKey) : null;
    if (!apiKey) throw new Error(`ASR 模型「${cfg.name}」缺少 API key，请到设置 → 语音输入补全`);
    if (!bytes.length) throw new Error('录音数据为空');
    if (bytes.byteLength > VOICE_MAX_BYTES) throw new Error(`录音超过 ${Math.floor(VOICE_MAX_BYTES / 1024 / 1024)} MiB 上限，请缩短录音`);

    const base = cfg.endpoint.replace(/\/+$/, '');
    const cleanMime = (mime || 'audio/webm').split(';')[0].trim().toLowerCase();
    const ext = MIME_EXT[cleanMime] ?? 'webm';
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(bytes)], { type: cleanMime }), `recording.${ext}`);
    form.append('model', cfg.model);
    form.append('response_format', 'json');
    if (cfg.language) form.append('language', cfg.language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`转写服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
      }
      const data = await res.json() as { text?: unknown } | null;
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (!text) throw new Error('转写结果为空，未识别到语音内容');
      return text;
    } catch (err) {
      if (controller.signal.aborted || (err as Error)?.name === 'AbortError') throw new Error('转写超时');
      throw new Error(`转写失败：${String((err as Error)?.message || err)}`);
    } finally {
      // Keep the deadline alive while reading both success and error bodies.
      clearTimeout(timer);
    }
  }
}

/** 解析落盘数据：兼容旧单配置形态与新多模型形态；坏数据按空列表处理。 */
function normalizeStored(raw: unknown): StoredVoice {
  if (!raw || typeof raw !== 'object') return { models: [], activeId: null };
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.models)) {
    const models = record.models
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
      .map((m, i) => ({
        id: typeof m.id === 'string' && m.id ? m.id : `m-${i + 1}`,
        name: typeof m.name === 'string' ? m.name : undefined,
        endpoint: typeof m.endpoint === 'string' ? m.endpoint : undefined,
        model: typeof m.model === 'string' ? m.model : undefined,
        language: typeof m.language === 'string' ? m.language : undefined,
        apiKey: typeof m.apiKey === 'string' ? m.apiKey : undefined,
      }));
    const activeId = typeof record.activeId === 'string' && record.activeId ? record.activeId : (models[0]?.id ?? null);
    return { models, activeId };
  }
  // 旧单配置形态：{ endpoint, model, language, apiKey } → 迁移为第一个模型。
  if (typeof record.endpoint === 'string' || typeof record.model === 'string' || typeof record.apiKey === 'string') {
    return {
      models: [{
        id: 'm-1',
        name: '默认转写模型',
        endpoint: typeof record.endpoint === 'string' ? record.endpoint : undefined,
        model: typeof record.model === 'string' ? record.model : undefined,
        language: typeof record.language === 'string' ? record.language : undefined,
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : undefined,
      }],
      activeId: 'm-1',
    };
  }
  return { models: [], activeId: null };
}
