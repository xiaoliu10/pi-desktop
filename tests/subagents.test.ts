import {it,expect} from 'vitest';
import {projectSubagents} from '../src/renderer/pi/subagents';
import type {ChatMessage,ToolPart} from '../src/renderer/replica/contracts';
const result=(agent='scout',exitCode=0)=>({agent,agentSource:'user',task:'Inspect',exitCode,messages:[{role:'assistant',content:[{type:'text',text:'Found it'}]}],usage:{input:12,output:3,turns:1,cost:.01}});
const part=(phase:ToolPart['phase'],results:unknown[],mode='single'):ToolPart=>({kind:'tool',id:'one',callId:'call-1',tool:'subagent',phase,status:phase==='result'?'done':'running',summary:'',resultDetails:{mode,agentScope:'both',projectAgentsDir:null,results}});
const messages=(...parts:ToolPart[]):ChatMessage[]=>[{id:'m',role:'assistant',parts}];
it('does not mistake exitCode=0 in streaming snapshots for completion',()=>{
 expect(projectSubagents(messages(part('progress',[result()])),true)[0].status).toBe('running');
 expect(projectSubagents(messages(part('progress',[result()])),false)[0].status).toBe('interrupted');
 expect(projectSubagents(messages(part('result',[result()])),false)[0].status).toBe('completed');
});
it('keeps stable sibling identities and handles mixed terminal outcomes',()=>{
 const p=part('result',[result('scout'),result('scout',1)],'parallel');p.status='error';
 const out=projectSubagents(messages(p),false);
 expect(out.map(c=>c.id)).toEqual(['call-1:0','call-1:1']);expect(out.map(c=>c.status)).toEqual(['completed','failed']);
 expect(out[0]).toMatchObject({tokens:15,turns:1,cost:.01});
});
it('marks unexecuted chain steps and preserves persisted results over stale progress',()=>{
 const call=part('call',[],'chain');call.argumentsText=JSON.stringify({chain:[{agent:'scout',task:'A'},{agent:'worker',task:'B'}]});
 const final=part('result',[result('scout',1)],'chain');
 const out=projectSubagents(messages(call,final,part('progress',[result()],'chain')),false);
 expect(out.map(c=>c.status)).toEqual(['failed','skipped']);expect(out[1].task).toBe('B');
});
it('does not interpret another plugin protocol or arbitrary output as official metadata',()=>{
 const p=part('result',[result()]);p.resultDetails={runId:'background',results:[result()]};
 expect(projectSubagents(messages(p),false)).toEqual([]);
});
it('retains the last snapshot as interrupted when abort has no final plugin details',()=>{
 const progress=part('progress',[result()]);progress.resultDetailsFinal=false;
 const end:ToolPart={...part('result',[]),resultDetails:undefined,resultDetailsFinal:false,status:'error'};
 const children=projectSubagents(messages(progress,end),false);
 expect(children[0].status).toBe('interrupted');expect(children[0].messages).toHaveLength(1);
});

it('merges disk-recovered subagents not in the session file', () => {
  // Session file has one completed subagent call
  const done = part('result', [result()]);
  // Disk recovery has a different callId that was interrupted
  const recovered = [{ callId: 'call-2', status: 'failed', details: { mode: 'single', agentScope: 'user', projectAgentsDir: null, results: [result('scout', 1)] } }];
  const out = projectSubagents(messages(done), false, recovered as any);
  expect(out).toHaveLength(2);
  expect(out[0].callId).toBe('call-1');
  expect(out[0].status).toBe('completed');
  expect(out[1].callId).toBe('call-2');
  expect(out[1].status).toBe('recovered');
  expect(out[1].recovered).toBe(true);
  expect(out[1].messages).toHaveLength(1);
});

it('does not duplicate subagents already in the session file', () => {
  const done = part('result', [result()]);
  const recovered = [{ callId: 'call-1', status: 'running', details: { mode: 'single', agentScope: 'user', projectAgentsDir: null, results: [result()] } }];
  const out = projectSubagents(messages(done), false, recovered as any);
  // Only the session-file version should appear (call-1:0 completed)
  expect(out).toHaveLength(1);
  expect(out[0].status).toBe('completed');
});
