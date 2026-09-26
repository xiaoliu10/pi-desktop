import { useEffect, useState } from 'react';
import type { VoiceAsrModel, VoiceAsrModelInput, VoiceConfig } from '../../shared/voice';

const EMPTY_FORM: VoiceAsrModelInput = { name: '', endpoint: '', model: '', language: '', apiKey: '' };

/**
 * 设置 → 语音输入：ASR 模型列表（可配置多个，指定一个生效）。
 * 开启语音输入的门槛是至少一个「就绪」模型；密钥由主进程加密保存，
 * 页面只回显 hasKey，留空提交 = 保持不变。
 */
export function VoicePane(props: { busy: boolean; act: (fn: () => Promise<unknown>, message?: string) => Promise<void> }) {
  const [config, setConfig] = useState<VoiceConfig>();
  const [editing, setEditing] = useState<VoiceAsrModelInput | null>(null);
  const [error, setError] = useState('');

  const reload = () => window.localPi.voiceConfig();

  useEffect(() => {
    reload().then(setConfig).catch(e => setError(String((e as Error).message || e)));
  }, []);

  const run = (fn: () => Promise<VoiceConfig>, message?: string, after?: () => void) =>
    props.act(async () => {
      const next = await fn();
      setConfig(next);
      setError('');
      after?.();
    }, message).catch(e => setError(String((e as Error).message || e)));

  const readyCount = config?.models.filter(m => m.ready).length ?? 0;
  const enabled = readyCount > 0;

  const save = () => {
    if (!editing) return;
    const patch: VoiceAsrModelInput = {
      name: editing.name?.trim(),
      endpoint: editing.endpoint?.trim(),
      model: editing.model?.trim(),
      language: editing.language?.trim(),
    };
    if (editing.id) patch.id = editing.id;
    if (editing.apiKey?.trim()) patch.apiKey = editing.apiKey.trim();
    void run(() => window.localPi.voiceSaveModel(patch), editing.id ? '模型已更新' : '模型已添加', () => setEditing(null));
  };

  return (
    <>
      <section className="pi-features__card">
        <h2>ASR 模型</h2>
        <p>输入框右下角的麦克风按钮会录音并转写为文字，追加到输入框（不会自动发送）。<strong>至少需要配置一个就绪的 ASR 模型（接口地址 + 模型 ID + API key 齐备）才能开启语音输入</strong>；转写始终使用「生效中」的那个模型。录音经浏览器采集后上传到模型配置的 OpenAI 兼容端点，API key 由系统钥匙串加密保存在主进程，不会出现在渲染进程。</p>
        <p role="status">{enabled
          ? `✓ 语音输入已开启 · ${readyCount} 个就绪模型${config?.activeId ? ` · 生效：${config.models.find(m => m.id === config.activeId)?.name ?? ''}` : ''}`
          : '○ 语音输入未开启 · 至少配置一个就绪的 ASR 模型'}</p>
        {!config && !error && <p>正在读取语音输入配置…</p>}
        {config?.models.length === 0 && <div className="pi-features__empty">还没有 ASR 模型。点击「添加模型」创建第一个。</div>}
        {config?.models.map(model => (
          <AsrModelRow
            key={model.id}
            model={model}
            active={model.id === config.activeId}
            busy={props.busy}
            onEdit={() => setEditing({ id: model.id, name: model.name, endpoint: model.endpoint, model: model.model, language: model.language, apiKey: '' })}
            onActivate={() => void run(() => window.localPi.voiceSetActive(model.id), `「${model.name}」已设为生效模型`)}
            onRemove={() => {
              if (window.confirm(`移除 ASR 模型「${model.name}」？其 API key 会一并删除。`)) {
                void run(() => window.localPi.voiceRemoveModel(model.id), '模型已移除');
              }
            }}
          />
        ))}
        <div className="pi-features__actions">
          <button className="pi-btn pi-btn--primary" disabled={props.busy} onClick={() => setEditing({ ...EMPTY_FORM })}>添加模型</button>
        </div>
        {error && <div className="pi-features__alert" role="alert">{error}</div>}
      </section>

      {editing && (
        <section className="pi-features__card">
          <h2>{editing.id ? '编辑模型' : '添加 ASR 模型'}</h2>
          <label>模型名称<input value={editing.name ?? ''} placeholder="OpenAI whisper" onChange={e => setEditing({ ...editing, name: e.target.value })}/></label>
          <label>接口地址<input value={editing.endpoint ?? ''} placeholder="https://api.openai.com/v1（留空 = OpenAI 默认）" onChange={e => setEditing({ ...editing, endpoint: e.target.value })} spellCheck={false}/></label>
          <label>转写模型 ID<input value={editing.model ?? ''} placeholder="whisper-1" onChange={e => setEditing({ ...editing, model: e.target.value })} spellCheck={false}/></label>
          <label>语言（ISO-639-1，留空自动检测）<input value={editing.language ?? ''} placeholder="zh" maxLength={16} onChange={e => setEditing({ ...editing, language: e.target.value })} spellCheck={false}/></label>
          <label>API key
            <input type="password" value={editing.apiKey ?? ''} placeholder={editing.id ? '留空保持已保存的 key' : 'sk-…'} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} autoComplete="off" spellCheck={false}/>
          </label>
          <div className="pi-features__actions">
            <button className="pi-btn pi-btn--primary" disabled={props.busy} onClick={save}>保存模型</button>
            <button className="pi-btn pi-btn--ghost" onClick={() => setEditing(null)}>取消</button>
          </div>
        </section>
      )}

      <section className="pi-features__card">
        <h2>兼容性说明</h2>
        <p>接口需兼容 OpenAI <code>POST /audio/transcriptions</code>（multipart：<code>file</code>、<code>model</code>、可选 <code>language</code>，Bearer 鉴权）。录音格式为 webm/opus（Chromium 默认），单次最长 5 分钟。</p>
      </section>
    </>
  );
}

function AsrModelRow(props: {
  model: VoiceAsrModel;
  active: boolean;
  busy: boolean;
  onEdit: () => void;
  onActivate: () => void;
  onRemove: () => void;
}) {
  const m = props.model;
  return (
    <article className="pi-features__row">
      <div>
        <strong>{m.name}</strong>
        <span className="pi-features__badge">
          {props.active ? '生效中 · ' : ''}{m.ready ? '就绪' : `未就绪${!m.hasKey ? ' · 缺 API key' : ''}`}
        </span>
        <code>{m.endpoint} · {m.model}{m.language ? ` · ${m.language}` : ''}</code>
      </div>
      <div className="pi-features__actions">
        {!props.active && <button className="pi-btn pi-btn--outline" disabled={props.busy || !m.ready} onClick={props.onActivate}>设为生效</button>}
        <button className="pi-btn pi-btn--outline" disabled={props.busy} onClick={props.onEdit}>编辑</button>
        <button className="pi-btn pi-btn--ghost" disabled={props.busy} onClick={props.onRemove}>删除</button>
      </div>
    </article>
  );
}
