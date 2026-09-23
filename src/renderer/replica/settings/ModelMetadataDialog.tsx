import { useEffect, useId, useRef, useState } from 'react';
import type { PiCatalogModel } from '../../../shared/pi';
import { Icon } from '../Icons';
import { commitModelDraft, createModelDraft, type ModelDraft } from './model-draft';

/** Interaction adapted from ZCode ProviderModelMetadataDialog / ModelEditorAdvanced.
 * pi owns runtime defaults and capability semantics; this dialog edits a disposable draft. */
export function ModelMetadataDialog({model, others, adding, onClose, onSave}: {
  model: PiCatalogModel; others: PiCatalogModel[]; adding: boolean;
  onClose: () => void; onSave: (model: PiCatalogModel) => Promise<void> | void;
}) {
  const [draft,setDraft] = useState(()=>createModelDraft(model));
  const [advanced,setAdvanced] = useState(false);
  const [error,setError] = useState<{field?: keyof ModelDraft; message:string} | null>(null);
  const [saving,setSaving] = useState(false);
  const savingRef=useRef(false), composing=useRef(false);
  const ref=useRef<HTMLDialogElement>(null);
  const titleId=useId(), advancedId=useId();
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement | null, dialog=ref.current!;
    dialog.showModal();
    const input=dialog.querySelector<HTMLInputElement>(`[name="${adding?'id':'contextWindow'}"]`);
    input?.focus(); input?.select();
    return ()=>{dialog.close(); if(previous?.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{if(error?.field)ref.current?.querySelector<HTMLElement>(`[name="${error.field}"]`)?.focus();},[error,advanced]);
  const patch=(value:Partial<ModelDraft>)=>setDraft(d=>({...d,...value}));
  const close=()=>{if(!savingRef.current)onClose();};
  const save=async()=>{
    if(savingRef.current || composing.current)return;
    const result=commitModelDraft(draft,others);
    if('field' in result){setError(result);if(result.field==='thinkingLevelMap')setAdvanced(true);return;}
    savingRef.current=true;setSaving(true);setError(null);
    try{await onSave(result.model);onClose();}
    catch(e){setError({message:e instanceof Error?e.message:String(e)});}
    finally{savingRef.current=false;setSaving(false);}
  };
  const input=(field:'id'|'name'|'contextWindow'|'maxTokens',label:string,placeholder?:string)=><label><span>{label}</span><input name={field} readOnly={field==='id'&&!adding} value={draft[field]} placeholder={placeholder} inputMode={field==='contextWindow'||field==='maxTokens'?'numeric':undefined} autoComplete="off" spellCheck={false} aria-invalid={error?.field===field} onChange={e=>patch({[field]:e.target.value})} onFocus={e=>{if(field==='contextWindow'||field==='maxTokens')e.target.select();}}/></label>;
  return <dialog ref={ref} className="pi-provider-dialog pi-model-dialog" aria-labelledby={titleId} onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}}}>
    <header className="pi-provider-dialog__header"><h2 id={titleId}>{adding?'添加模型':'编辑模型'}</h2><button type="button" className="pi-iconbtn" disabled={saving} aria-label="关闭模型编辑" onClick={close}><Icon name="x" size={18}/></button></header>
    <form className="pi-providerform" noValidate onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={e=>{if(e.key==='Enter'&&(composing.current||e.nativeEvent.isComposing||e.nativeEvent.keyCode===229))e.preventDefault();}} onSubmit={e=>{e.preventDefault();void save();}}>
      <fieldset disabled={saving}>
        {input('id','模型 ID','服务商提供的模型 ID')}
        {input('name','显示名称','可选，默认显示模型 ID')}
        {input('contextWindow','上下文窗口（tokens）','pi 默认：128000')}
        {input('maxTokens','最大输出（tokens）','pi 默认：16384')}
        <button type="button" className="pi-model-advanced-trigger" aria-expanded={advanced} aria-controls={advancedId} onClick={()=>setAdvanced(v=>!v)}><span aria-hidden="true">{advanced?'⌄':'›'}</span>高级配置</button>
        <div id={advancedId} hidden={!advanced} className="pi-model-advanced">
          <section><h3>输入类型</h3><div className="pi-model-options"><button type="button" role="checkbox" aria-checked="true" aria-disabled="true"><span className="pi-model-checkbox" aria-hidden="true"><Icon name="check" size={11}/></span>文本</button><button type="button" role="checkbox" aria-checked={draft.image} onClick={()=>patch({image:!draft.image})}><span className="pi-model-checkbox" aria-hidden="true">{draft.image&&<Icon name="check" size={11}/>}</span>图片</button></div></section>
          <section><h3>模型能力</h3><div className="pi-model-options"><button type="button" role="checkbox" aria-checked={draft.reasoning} onClick={()=>patch({reasoning:!draft.reasoning})}><span className="pi-model-checkbox" aria-hidden="true">{draft.reasoning&&<Icon name="check" size={11}/>}</span>推理 / 思考</button></div></section>
          <label><span>推理等级映射</span><textarea name="thinkingLevelMap" rows={5} spellCheck={false} value={draft.thinkingLevelMap} aria-invalid={error?.field==='thinkingLevelMap'} placeholder={'{\n  "high": "high",\n  "xhigh": null\n}'} onChange={e=>patch({thinkingLevelMap:e.target.value})}/><small>支持 off、minimal、low、medium、high、xhigh、max。字符串指定服务商参数，null 禁用该等级；留空使用 pi 默认映射。</small></label>
        </div>
        <p className="pi-providerform__hint">留空的参数使用 pi 默认值。能力声明应与服务商提供的模型一致。</p>
      </fieldset>
      {error&&<p className="pi-providerform__err" role="alert">{error.message}</p>}
      <footer className="pi-providerform__actions"><button type="button" disabled={saving} className="pi-btn pi-btn--ghost pi-model-restore" onClick={()=>{setDraft(d=>({...createModelDraft({id:d.id,name:d.name}),image:false,reasoning:false}));setError(null);}}>恢复 pi 默认</button><button type="button" disabled={saving} className="pi-btn pi-btn--outline" onClick={close}>取消</button><button type="submit" disabled={saving} className="pi-btn pi-btn--primary">{saving?'保存中…':'保存'}</button></footer>
    </form>
  </dialog>;
}
