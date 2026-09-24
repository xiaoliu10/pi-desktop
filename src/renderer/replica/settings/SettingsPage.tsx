import { ModelMetadataDialog } from './ModelMetadataDialog';
import type { PiCatalogModel } from '../../../shared/pi';
/**
 * Settings page replica (U05): full-page layout with left nav (back, search,
 * grouped sections) and right content panes. Reference:
 * docs/ui-reference-baseline.md (settings-live / settings-models).
 */

import { useEffect, useRef, useState } from 'react';
import type {
  SettingRowData,
  SettingsProps,
  SettingsSectionData,
} from '../contracts';
import { Icon } from '../Icons';
import { filterNavSections, filterRows } from './helpers';
import './settings.css';

export function SettingsPage(props: SettingsProps) {
  const nav = filterNavSections(demoNavFromLabels(props), props.query);
  return (
    <div className="pi-settings">
      <aside className="pi-settings__nav">
        <button className="pi-settings__back" onClick={props.onBack}>
          <Icon name="chevron-left" size={15} />
          {props.labels.backToApp}
        </button>
        <input
          className="pi-settings__search"
          placeholder={props.labels.searchSettings}
          value={props.query}
          onChange={(e) => props.onSearch(e.target.value)}
          aria-label={props.labels.searchSettings}
        />
        <nav className="pi-settings__sections">
          {nav.map((section) => (
            <div key={section.label} className="pi-settings__section">
              <div className="pi-settings__sectionlabel">{section.label}</div>
              {section.items.map((item) => (
                <button
                  key={item.id}
                  className={`pi-settings__navitem ${props.page === item.id ? 'pi-settings__navitem--on' : ''}`}
                  aria-current={props.page === item.id ? 'page' : undefined}
                  onClick={() => props.onSelectPage(item.id)}
                >
                  <Icon name={item.icon} size={15} />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="pi-settings__content">
        {props.pageContent === undefined && props.page === 'general' && <GeneralPane {...props} />}
        {props.pageContent === undefined && props.page === 'models' && <ModelsPane {...props} />}
        {props.pageContent === undefined && props.page === 'info' && <InfoPane {...props} />}
        {props.pageContent}
        {props.pageContent === undefined && !['general', 'models', 'info'].includes(props.page) && (
          <div className="pi-settings__empty">
            <div className="pi-settings__emptytitle">{props.labels.emptyGeneric}</div>
            <div className="pi-settings__emptyhint">{props.labels.emptyGenericHint}</div>
          </div>
        )}
      </main>
    </div>
  );
}

function demoNavFromLabels(props: SettingsProps) {
  const L = props.labels;
  return [
    {
      label: L.appearance === 'Appearance' ? 'General' : '基础设置',
      items: [
        { id: 'general' as const, label: L.general, icon: 'sliders' as const },
        { id: 'shortcuts' as const, label: L.shortcuts, icon: 'keyboard' as const },
      ],
    },
    {
      label: 'Agent',
      items: [
        { id: 'instructions' as const, label: L.instructions, icon: 'instructions' as const },
        { id: 'models' as const, label: L.models, icon: 'bot' as const },
        { id: 'skills' as const, label: L.skills, icon: 'book' as const },
        { id: 'mcp' as const, label: L.mcp, icon: 'stack' as const },
        { id: 'extensions' as const, label: L.extensions, icon: 'plug' as const },
        { id: 'subagents' as const, label: L.subagents, icon: 'box' as const },
      ],
    },
    {
      label: L.appearance === 'Appearance' ? 'Workspace' : '工作区',
      items: [
        ...(!props.demo ? [{ id: 'workspace' as const, label: L.appearance === 'Appearance' ? 'Connection' : '连接', icon: 'sliders' as const }] : []),
        { id: 'import' as const, label: L.import, icon: 'download' as const },
        { id: 'projects' as const, label: L.projects, icon: 'archive' as const },
        ...(!props.demo ? [
          { id: 'archived' as const, label: L.appearance === 'Appearance' ? 'Archived chats' : '已归档会话', icon: 'archive' as const },
          { id: 'usage' as const, label: L.appearance === 'Appearance' ? 'Usage statistics' : '数据统计', icon: 'info' as const },
        ] : []),
      ],
    },
    {
      label: L.appearance === 'Appearance' ? 'System' : '系统',
      items: [{ id: 'info' as const, label: L.info, icon: 'info' as const }],
    },
  ];
}

function Row({ row, labels, onControl }: { row: SettingRowData; labels: SettingsProps['labels']; onControl: SettingsProps['onRowControl'] }) {
  const ctrl = row.control;
  return (
    <div className="pi-settingrow">
      <div className="pi-settingrow__text">
        <div className="pi-settingrow__title">{row.title}</div>
        {row.description && <div className="pi-settingrow__desc">{row.description}</div>}
      </div>
      <div className="pi-settingrow__control">
        {ctrl.kind === 'select' && (
          <select
            className="pi-settingrow__select"
            value={ctrl.value}
            disabled={ctrl.disabled}
            onChange={(e) => onControl(row.id, e.target.value)}
            aria-label={row.title}
          >
            {ctrl.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        )}
        {ctrl.kind === 'segmented' && (
          <div className="pi-settingrow__segmented" role="radiogroup" aria-label={row.title}>
            {ctrl.options.map((o) => (
              <button
                key={o}
                role="radio"
                aria-checked={o === ctrl.value}
                className={`pi-settingrow__seg ${o === ctrl.value ? 'pi-settingrow__seg--on' : ''}`}
                onClick={() => onControl(row.id, o)}
              >
                {o}
              </button>
            ))}
          </div>
        )}
        {ctrl.kind === 'slider' && (
          <div className="pi-settingrow__sliderwrap">
            {ctrl.options && (
              <div className="pi-settingrow__segmented pi-settingrow__segmented--inline">
                {ctrl.options.map((o, i) => {
                  const step = (ctrl.max - ctrl.min) / Math.max(1, ctrl.options!.length - 1);
                  const target = ctrl.min + i * step;
                  return (
                    <button
                      key={o}
                      className={`pi-settingrow__seg ${Math.abs(target - ctrl.value) < step / 2 ? 'pi-settingrow__seg--on' : ''}`}
                      onClick={() => onControl(row.id, target)}
                    >
                      {o}
                    </button>
                  );
                })}
              </div>
            )}
            <input
              type="range"
              className="pi-settingrow__slider"
              min={ctrl.min}
              max={ctrl.max}
              value={ctrl.value}
              onChange={(e) => onControl(row.id, Number(e.target.value))}
              aria-label={row.title}
            />
            <span className="pi-settingrow__sliderval">
              {ctrl.value}
              {ctrl.suffix}
            </span>
          </div>
        )}
        {ctrl.kind === 'toggle' && (
          <button
            role="switch"
            aria-checked={ctrl.value}
            aria-label={row.title}
            className={`pi-switch ${ctrl.value ? 'pi-switch--on' : ''}`}
            onClick={() => onControl(row.id, !ctrl.value)}
          >
            <span className="pi-switch__knob" />
          </button>
        )}
        {ctrl.kind === 'button' && (
          <button className="pi-btn pi-btn--outline" onClick={() => onControl(row.id, true)}>
            {ctrl.label}
          </button>
        )}
        {ctrl.kind === 'static' && <span className="pi-settingrow__static">{ctrl.text}</span>}
      </div>
    </div>
  );
}

function GeneralPane(props: SettingsProps) {
  const sections = filterRows(props.sections, props.query);
  return (
    <>
      <h1 className="pi-settings__title">{props.labels.general}</h1>
      {sections.map((s: SettingsSectionData) => (
        <section key={s.title} className="pi-settings__block">
          <h2 className="pi-settings__blocktitle">{s.title}</h2>
          <div className="pi-settings__rows">
            {s.rows.map((row) => (
              <Row key={row.id} row={row} labels={props.labels} onControl={props.onRowControl} />
            ))}
          </div>
        </section>
      ))}
      {sections.length === 0 && <div className="pi-settings__empty">{props.query ? props.labels.searchSettings : ''}</div>}
    </>
  );
}

function ModelsPane(props: SettingsProps) {
  const L = props.labels;
  const form = props.providerForm;
  const setForm = props.onSetProviderForm;
  const [modelEditor,setModelEditor] = useState<{model:PiCatalogModel; index?:number; providerId?:string; originalId?:string} | null>(null);
  const formErrors: string[] = form.error ? [form.error] : [];
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeForm = () => { if (!form.saving) setForm({ open:false, editingId:null, name:'', baseUrl:'', apiKey:'', modelLine:'', models:undefined, error:undefined }); };
  useEffect(() => {
    if (!form.open) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { dialog?.close(); if(previous?.isConnected)previous.focus(); };
  }, [form.open]);

  // 左列表选中项：默认第一个供应商（ZCode 式 master-detail）。
  const [selectedId, setSelectedId] = useState<string | null>(props.providers[0]?.id ?? null);
  const selected = props.providers.find((p) => p.id === selectedId) ?? props.providers[0] ?? null;
  const editable = selected?.source === 'models.json';
  const openCreate = () => setForm({ open: true, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '', models: [], error: undefined });
  return (
    <>
      <h1 className="pi-settings__title">{L.modelConfiguration}</h1>
      {props.catalogWarning&&<p role="alert" className="pi-providerform__err">{props.catalogWarning}</p>}

      {form.open && (
        <dialog ref={dialogRef} className="pi-provider-dialog" aria-labelledby="pi-provider-dialog-title" aria-modal="true" onCancel={e=>{e.preventDefault();closeForm();}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeForm();}}}>
          <header className="pi-provider-dialog__header"><h2 id="pi-provider-dialog-title">{form.editingId ? L.providerFormEdit : L.providerFormTitle}</h2><button type="button" className="pi-iconbtn" aria-label={L.cancel} disabled={form.saving} onClick={closeForm}><Icon name="x" size={18}/></button></header>
          <form className="pi-providerform" onSubmit={e=>{e.preventDefault();if(!form.saving)props.onSaveProvider();}}>
            <fieldset disabled={form.saving}>
            <label>
              <span>{L.providerName}</span>
              <input autoFocus value={form.name} onChange={(e) => setForm({ name: e.target.value })} aria-label={L.providerName} />
              {formErrors.includes('name') && <em className="pi-providerform__err">{L.nameRequired}</em>}
            </label>
            <label>
              <span>{L.providerBaseUrl}</span>
              <input value={form.baseUrl} onChange={(e) => setForm({ baseUrl: e.target.value })} aria-label={L.providerBaseUrl} placeholder="https://api.example.com/v1" />
            </label>
            <label>
              <span>{L.providerApiKey}</span>
              <input type="password" value={form.apiKey} onChange={(e) => setForm({ apiKey: e.target.value })} aria-label={L.providerApiKey} autoComplete="new-password" placeholder={form.editingId ? '留空保留现有 API Key' : 'sk-…'} />
            </label>
            <div className="pi-model-editor">
              <div className="pi-model-editor__head"><strong>{L.providerModels}</strong><button type="button" className="pi-btn pi-btn--outline" onClick={()=>setModelEditor({model:{id:''}})}><Icon name="plus" size={14}/>添加模型</button></div>
              {(form.models??[]).map((model,index)=><div className="pi-model-summary" key={index}>
                <div><strong>{model.name||model.id}</strong><small>{model.id} · {model.contextWindow?.toLocaleString()??'默认'} 上下文 · {model.input?.includes('image')?'图片':'文本'}{model.reasoning?' · 推理':''}</small></div>
                <button type="button" className="pi-iconbtn" aria-label={`编辑模型 ${model.id}`} onClick={()=>setModelEditor({model,index,originalId:model.id})}><Icon name="pencil" size={14}/></button>
                <button type="button" className="pi-iconbtn" aria-label={`移除模型 ${model.id}`} onClick={()=>setForm({models:form.models!.filter((_,i)=>i!==index)})}><Icon name="trash" size={14}/></button>
              </div>)}
              {!form.models?.length&&<p className="pi-providerform__hint">添加模型，配置上下文窗口和模型能力。</p>}
            </div>
            </fieldset>
            {form.error && <p className="pi-providerform__err" role="alert">{form.error}</p>}
            <div className="pi-providerform__actions">
              <button type="button" disabled={form.saving} className="pi-btn pi-btn--outline" onClick={closeForm}>
                {L.cancel}
              </button>
              <button type="submit" disabled={form.saving} className="pi-btn pi-btn--primary">
                {form.saving ? '保存中…' : L.save}
              </button>
            </div>
          </form>
        </dialog>
      )}

      {modelEditor && <ModelMetadataDialog model={modelEditor.model} adding={modelEditor.originalId===undefined}
        others={(modelEditor.providerId ? props.providers.find(p=>p.id===modelEditor.providerId)?.models??[] : form.models??[]).filter((m,i)=>modelEditor.providerId?m.id!==modelEditor.originalId:i!==modelEditor.index)}
        onClose={()=>setModelEditor(null)} onSave={async model=>{
          if(modelEditor.providerId) {
            if(!props.onSaveProviderModel)throw new Error('模型保存不可用');
            await props.onSaveProviderModel(modelEditor.providerId,model,modelEditor.originalId);
          } else {
            const models=[...(form.models??[])];
            if(modelEditor.index===undefined)models.push(model);else models[modelEditor.index]=model;
            setForm({models});
          }
        }}/>} 
      <section className="pi-settings__block">
        <h2 className="pi-settings__blocktitle">{L.defaults}</h2>
        <div className="pi-settings__rows">
          <div className="pi-settingrow">
            <div className="pi-settingrow__text">
              <div className="pi-settingrow__title">{L.defaultModel}</div>
              <div className="pi-settingrow__desc">{props.defaultModelLabel ?? L.noDefault}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="pi-settings__block">
        <div className="pi-settings__blockhead">
          <h2 className="pi-settings__blocktitle">
            {L.aiProviders}{' '}
            <span className="pi-count-badge">{props.providers.length}</span>
          </h2>
          <button className="pi-btn pi-btn--outline" onClick={props.onRefreshCatalog}>刷新模型目录</button>
          <button className="pi-btn pi-btn--primary" onClick={openCreate}>
            <Icon name="plus" size={14} />
            {L.addProvider}
          </button>
        </div>
        {props.providers.length === 0 ? (
          <div className="pi-settingrow pi-settingrow--card">
            <div className="pi-settingrow__text">
              <div className="pi-settingrow__desc">{L.noVendor}</div>
            </div>
          </div>
        ) : (
          <div className="pi-models-split">
            {/* 左：供应商列表 */}
            <div className="pi-models-split__nav" role="listbox" aria-label={L.aiProviders}>
              {props.providers.map((p) => (
                <button
                  key={p.id}
                  role="option"
                  aria-selected={selected?.id === p.id}
                  className={`pi-models-split__item ${selected?.id === p.id ? 'pi-models-split__item--on' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="pi-models-split__name">
                    {p.name}
                    {p.isDefault && <span className="pi-marketcard__verified pi-settingrow__default">{L.defaultBadge}</span>}
                  </span>
                  <span className="pi-models-split__meta">{p.modelCount} models{p.loginAvailable ? (p.auth==='oauth'?' · 套餐已登录':' · 可登录套餐'):p.auth==='api_key'?' · API Key':''}</span>
                  {/* 同名供应商（如多个 CCR）靠 id 区分，对齐模型选择列表的编号展示 */}
                  <span className="pi-models-split__id" title={p.id}>{p.id}</span>
                </button>
              ))}
            </div>
            {/* 右：选中供应商的模型列表与操作 */}
            <div className="pi-models-split__detail">
              {selected && (
                <>
                  <div className="pi-models-split__head">
                    <div className="pi-models-split__title">
                      {selected.name}
                      {selected.isDefault && <span className="pi-marketcard__verified pi-settingrow__default">{L.defaultBadge}</span>}
                    </div>
                    <div className="pi-models-split__id" title={selected.id}>{selected.id}</div>
                    <div className="pi-models-split__ops">
                      {!editable && <span className="pi-models-split__hint">pi 内核管理的模型目录</span>}
                      {selected.loginAvailable&&props.onLoginProvider&&<button className="pi-btn pi-btn--outline" onClick={()=>props.onLoginProvider!(selected.id)}>{selected.auth==='oauth'?'重新登录':'登录编程套餐'}</button>}
                      {editable && (
                        <>
                          {!selected.isDefault && (
                            <button className="pi-btn pi-btn--ghost" onClick={() => props.onMakeDefault(selected.id)}>{L.makeDefault}</button>
                          )}
                          <button className="pi-iconbtn" aria-label={L.edit} title={L.edit} onClick={() => props.onEditProvider(selected.id)}>
                            <Icon name="pencil" size={14} />
                          </button>
                          <button className="pi-iconbtn" aria-label={L.delete} title={L.delete} onClick={() => props.onDeleteProvider(selected.id)}>
                            <Icon name="trash" size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="pi-models-split__baseurl pi-mono">{selected.baseUrl}</div>
                  {selected.loginAvailable&&<p className="pi-providerform__hint">{selected.auth==='oauth'?'已检测到 pi 登录凭证。':'登录后可使用套餐模型。'}下方为 pi 内核模型目录，实际可用范围取决于账号权益。</p>}
                  {!selected.models.length&&<p className="pi-providerform__hint">暂无模型目录。部分提供商需登录后刷新才能获取模型。</p>}
                  <div className="pi-model-editor__head"><div className="pi-models-split__listtitle">{L.modelsListTitle} · {selected.modelCount}</div>{editable&&props.onSaveProviderModel&&<button type="button" className="pi-btn pi-btn--outline" onClick={()=>setModelEditor({model:{id:''},providerId:selected.id})}><Icon name="plus" size={14}/>添加模型</button>}</div>
                  <div className="pi-models-split__models">
                    {selected.models.map((m) => (
                      <div key={m.id} className="pi-models-split__model">
                        {props.onSelectDefaultModel&&selected.auth!=='none'&&<button className="pi-btn pi-btn--ghost" aria-label={`设为默认模型 ${m.id}`} onClick={()=>props.onSelectDefaultModel!(selected.id,m.id)}>设为默认</button>}
                        <span className="pi-models-split__modelname">{m.name || m.id}{m.reasoning ? ' · 推理' : ''}</span>
                        <span className="pi-models-split__modelid pi-mono">{m.id}</span><span className="pi-models-split__hint">{m.contextWindow ? `${m.contextWindow.toLocaleString()} 上下文` : '默认上下文'} · {m.maxTokens ? `${m.maxTokens.toLocaleString()} 最大输出` : '默认输出'} · {m.input?.includes('image') ? '文本 / 图片' : '仅文本'}</span>{editable&&props.onSaveProviderModel&&<button type="button" className="pi-iconbtn" aria-label={`编辑模型 ${m.id}`} onClick={()=>setModelEditor({model:m,providerId:selected.id,originalId:m.id})}><Icon name="pencil" size={14}/></button>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function InfoPane(props: SettingsProps) {
  return (
    <>
      <h1 className="pi-settings__title">{props.labels.about}</h1>
      <section className="pi-settings__block">
        <div className="pi-settings__rows">
          <div className="pi-settingrow pi-settingrow--card">
            <div className="pi-settingrow__text">
              <div className="pi-settingrow__title">{props.labels.version}</div>
              <div className="pi-settingrow__desc pi-mono">0.1.0-desktop</div>
            </div>
          </div>
          <div className="pi-settingrow pi-settingrow--card">
            <div className="pi-settingrow__text">
              <div className="pi-settingrow__title">{props.labels.runtime}</div>
              <div className="pi-settingrow__desc">{props.labels.demoEnv}</div>
            </div>
          </div>
        </div>
      </section>
      {props.infoExtra}
    </>
  );
}
