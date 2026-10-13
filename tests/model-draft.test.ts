import { describe,it,expect } from 'vitest';
import { createModelDraft,commitModelDraft } from '../src/renderer/replica/settings/model-draft';

describe('model metadata draft transactions',()=>{
  it('keeps edits local and round trips explicit settings',()=>{
    const model={id:'model',contextWindow:128000,maxTokens:8192,input:['text','image'],reasoning:true,thinkingLevelMap:{high:'high',max:null}};
    const draft=createModelDraft(model);
    draft.contextWindow='256000';
    expect(model.contextWindow).toBe(128000);
    expect(commitModelDraft(draft,[])).toEqual({model:{...model,name:undefined,contextWindow:256000}});
  });
  it('validates the error field without swallowing invalid text',()=>{
    const draft=createModelDraft({id:'m'});
    expect(commitModelDraft({...draft,contextWindow:'1e5'},[])).toMatchObject({field:'contextWindow'});
    expect(commitModelDraft({...draft,contextWindow:'100',maxTokens:'101'},[])).toMatchObject({field:'maxTokens'});
    expect(commitModelDraft(draft,[{id:'m'}])).toMatchObject({field:'id'});
    for(const text of ['{','[]','{"bad":"high"}','{"high":true}','{"high":""}'])expect(commitModelDraft({...draft,thinkingLevelMap:text},[])).toMatchObject({field:'thinkingLevelMap'});
  });
  it('uses sparse defaults and supports null to disable reasoning levels',()=>{
    const draft=createModelDraft({id:'new'});
    expect(commitModelDraft(draft,[])).toEqual({model:{id:'new',name:undefined,contextWindow:undefined,maxTokens:undefined,input:['text'],reasoning:false,thinkingLevelMap:undefined}});
    expect(commitModelDraft({...draft,thinkingLevelMap:'{"low":null,"high":"high"}'},[])).toMatchObject({model:{thinkingLevelMap:{low:null,high:'high'}}});
    for(const text of ['{','[]','{"bad":{}}','{"high":"str"}','{"high":null}','{"high":[]}'])expect(commitModelDraft({...draft,samplingParams:text},[])).toMatchObject({field:'samplingParams'});
    expect(commitModelDraft({...draft,samplingParams:'{"high":{"temperature":0.7}}'},[])).toMatchObject({model:{samplingParamsByThinkingLevel:{high:{temperature:0.7}}}});
  });
});

describe('session affinity (compat) draft',()=>{
  it('reads the three states from model.compat',()=>{
    expect(createModelDraft({id:'m'}).sessionAffinity).toBe('default');
    expect(createModelDraft({id:'m',compat:{sendSessionAffinityHeaders:true}}).sessionAffinity).toBe('anthropic');
    expect(createModelDraft({id:'m',compat:{sendSessionAffinityHeaders:true,sessionAffinityFormat:'openrouter'}}).sessionAffinity).toBe('openrouter');
    // 显式 false（例如 OpenRouter 供应商想关掉自动开启）也读作 default
    expect(createModelDraft({id:'m',compat:{sendSessionAffinityHeaders:false,sessionAffinityFormat:'openrouter'}}).sessionAffinity).toBe('default');
  });
  it('writes compat per state and preserves unknown compat keys',()=>{
    const base=createModelDraft({id:'m',compat:{supportsReasoningEffort:true}});
    const openrouter=commitModelDraft({...base,sessionAffinity:'openrouter'},[],{id:'m',compat:{supportsReasoningEffort:true}});
    expect(openrouter).toMatchObject({model:{compat:{sendSessionAffinityHeaders:true,sessionAffinityFormat:'openrouter',supportsReasoningEffort:true}}});
    const anthropic=commitModelDraft({...base,sessionAffinity:'anthropic'},[],{id:'m',compat:{}});
    expect(anthropic).toMatchObject({model:{compat:{sendSessionAffinityHeaders:true}}});
    expect((anthropic as Extract<typeof anthropic,{model:unknown}>).model.compat!.sessionAffinityFormat).toBeUndefined();
    // default：去掉亲和两键；只剩未知键时保留 compat，全空则 undefined
    const offKeep=commitModelDraft({...base,sessionAffinity:'default'},[],{id:'m',compat:{sendSessionAffinityHeaders:true,sessionAffinityFormat:'openrouter',supportsReasoningEffort:true}});
    expect(offKeep).toMatchObject({model:{compat:{supportsReasoningEffort:true}}});
    expect((offKeep as Extract<typeof offKeep,{model:unknown}>).model.compat!.sendSessionAffinityHeaders).toBeUndefined();
    const offEmpty=commitModelDraft({...createModelDraft({id:'m',compat:{sendSessionAffinityHeaders:true}}),sessionAffinity:'default'},[],{id:'m',compat:{sendSessionAffinityHeaders:true}});
    expect((offEmpty as Extract<typeof offEmpty,{model:unknown}>).model.compat).toBeUndefined();
  });
  it('does not emit compat when nothing changed (no-op save stays sparse)',()=>{
    const model={id:'m',compat:{sendSessionAffinityHeaders:true,sessionAffinityFormat:'openrouter'} as Record<string,unknown>};
    const result=commitModelDraft(createModelDraft(model),[],model);
    const initial=commitModelDraft(createModelDraft(model),[],model);
    expect(JSON.stringify(result.model.compat)).toBe(JSON.stringify(initial.model.compat));
  });
});
