/**
 * 语音输入（云端转写）Desktop 契约。
 *
 * 录音发生在 renderer（getUserMedia + MediaRecorder），转写在 main 进程走
 * OpenAI 兼容的 `/audio/transcriptions` 端点；API key 用 safeStorage 加密落盘，
 * 永不回传 renderer（只回 hasKey 布尔值）。
 *
 * 开启门槛：至少配置一个「就绪」的 ASR 模型（端点 + 模型 + 密钥齐备），
 * 否则输入框麦克风按钮引导去设置页。
 */

/** 单个 ASR 模型的回传视图：不含密钥明文。 */
export interface VoiceAsrModel {
  id: string;
  /** 显示名称，如「OpenAI whisper」。 */
  name: string;
  /** 形如 https://api.openai.com/v1（末尾斜杠可有可无）。 */
  endpoint: string;
  /** 转写模型 ID，如 whisper-1。 */
  model: string;
  /** ISO-639-1 语言码，空串 = 自动检测。 */
  language: string;
  /** 是否已保存 API key（明文只在 main 解密使用）。 */
  hasKey: boolean;
  /**
   * 是否可直接用于转写：endpoint 为 http(s)、model 非空、密钥已配置。
   * 未就绪的模型仍回传给设置页展示，但不计入开启门槛。
   */
  ready: boolean;
}

/** 保存入参：id 存在 = 更新该模型；apiKey 缺省表示保持不变，空串表示清除。 */
export interface VoiceAsrModelInput {
  id?: string;
  name?: string;
  endpoint?: string;
  model?: string;
  language?: string;
  apiKey?: string;
}

/** 回传给 renderer 的配置视图：模型列表 + 当前生效模型。 */
export interface VoiceConfig {
  models: VoiceAsrModel[];
  /** 生效模型 id；无模型时为 null。 */
  activeId: string | null;
}

/** 单次录音的上限：本地缓冲后一次性上传，5 分钟 webm/opus 约 2-4 MiB。 */
export const VOICE_MAX_RECORD_MS = 5 * 60_000;
/** 上传音频大小硬上限（对齐 OpenAI 25 MB 的转写接口限制，留出表单开销）。 */
export const VOICE_MAX_BYTES = 24 * 1024 * 1024;
