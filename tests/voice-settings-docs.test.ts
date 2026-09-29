import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VoicePane } from '../src/renderer/pi/VoicePane';
import { VOICE_MAX_BYTES, VOICE_MAX_RECORD_MS } from '../src/shared/voice';

const paneSource = fs.readFileSync(new URL('../src/renderer/pi/VoicePane.tsx', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const voiceDocs = readme.split('## 语音输入\n')[1]?.split('\n## ')[0] ?? '';

function renderPane(busy = false) {
  return renderToStaticMarkup(createElement(VoicePane, {
    busy,
    act: async fn => { await fn(); },
  }));
}

describe('voice settings keep configuration in UI and compatibility in README', () => {
  it('renders concise operational/privacy hints without a compatibility card or dead link', () => {
    const html = renderPane();
    expect(html).toContain('<h2>ASR 模型</h2>');
    expect(html).toContain('生效中');
    expect(html).toContain('追加到输入框，不会自动发送');
    expect(html).toContain('录音会上传到生效模型的接口地址');
    expect(html).toContain('已保存的密钥不回显');
    expect(html).toContain('兼容性与配置示例见 README「语音输入」');
    expect(html).not.toContain('<a');
    expect(html.match(/<section\b/g)).toHaveLength(1);
    for (const prose of ['兼容性说明', 'multipart', 'input_audio', 'asr_options', '404', '16kHz']) {
      // Check source as well so the long card cannot sneak into the editing branch.
      expect(paneSource).not.toContain(prose);
    }
  });

  it('preserves configuration controls, status, busy and error handling', () => {
    expect(renderPane()).toContain('role="status"');
    expect(renderPane()).toContain('正在读取语音输入配置');
    expect(renderPane(true)).toMatch(/<button[^>]*disabled=""[^>]*>添加模型/);
    for (const label of ['模型名称', '接口地址', '转写模型 ID', '调用方式', '语言（ISO-639-1', 'API key', '保存模型', '取消', '设为生效']) {
      expect(paneSource).toContain(label);
    }
    expect(paneSource).toContain('<option value="transcriptions">OpenAI 转写端点（/audio/transcriptions）</option>');
    expect(paneSource).toContain('<option value="chat">Chat 多模态（/chat/completions，MiMo 等）</option>');
    expect(paneSource).toContain('role="alert"');
    expect(paneSource).toContain('window.localPi.voiceSaveModel(patch)');
    expect(paneSource).toContain('setError(String((e as Error).message || e))');
    expect(paneSource).toContain('留空保持已保存的 key');
  });

  it('documents setup examples and the actual two wire formats', () => {
    expect(voiceDocs).toContain('设置 → 语音输入 → 添加模型');
    expect(voiceDocs).toContain('配置示例');
    expect(voiceDocs).toContain('不要附加');
    expect(voiceDocs).toContain('不代表已验证远端接口或账号权限');
    for (const term of ['POST /audio/transcriptions', 'multipart', 'response_format=json', 'POST /chat/completions', 'input_audio.data', 'asr_options.language', 'choices[0].message.content', 'Bearer']) {
      expect(voiceDocs).toContain(term);
    }
    expect(voiceDocs).toContain('具体接口地址、模型、API key 和套餐的音频权限');
    expect(voiceDocs).toContain('不能仅凭模型名称或 token-plan 地址判断一定可用');
  });

  it('documents one-time 404 fallback, persistence guards and non-fallback errors', () => {
    for (const term of ['HTTP 404', '自动尝试一次', '同一基础地址、模型、密钥、语言和音频', '非空文字', '保存其调用方式为 `chat`', '应用重启后', '原模型已编辑或删除', '不覆盖当前设置', '保存失败', '不更改调用方式', '其他非 404 HTTP 错误或网络错误', '不会反向回退', '120 秒']) {
      expect(voiceDocs).toContain(term);
    }
  });

  it('documents bounded best-effort audio conversion rather than guaranteed WAV', () => {
    expect(voiceDocs).toContain(`${VOICE_MAX_RECORD_MS / 60_000} 分钟`);
    expect(voiceDocs).toContain(`${VOICE_MAX_BYTES / 1024 / 1024} MiB`);
    for (const term of ['16 kHz、单声道、16-bit PCM WAV', 'AudioContext', '解码/转码失败', '原始录音格式', '不能保证每次上传都是 WAV']) {
      expect(voiceDocs).toContain(term);
    }
  });

  it('documents append-only input and actual key storage/privacy boundaries', () => {
    for (const term of ['追加到输入框，不会自动发送', '录音会上传', '并非离线识别', 'voice.json', 'safeStorage', 'plain:', 'Base64', '这不是加密', 'hasKey', '不向渲染进程回传已保存的密钥明文']) {
      expect(voiceDocs).toContain(term);
    }
  });
});
