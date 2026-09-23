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
  });
});
