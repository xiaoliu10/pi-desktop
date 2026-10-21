import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { PiEntry, PiHistory, PiRun } from '../src/shared/pi';

const key='ps-test';
const run:PiRun={key,generation:'g',cwd:'/mock',file:'/mock/session',status:'running',models:[],commands:[],pending:0};
const mk=(n:number)=>Array.from({length:n},(_,i)=>({id:`e${i}`,type:'message',message:{role:i%2?'assistant':'user',content:`t${i}`}} as PiEntry));
let emit:(e:any)=>void; let api:any;
const hist=(branch:PiEntry[],total=5676):PiHistory=>({branch,entries:branch,leaves:[],leafId:branch.at(-1)!.id,session:{key} as any,syncedAt:0,truncated:{total,returned:branch.length}});

beforeAll(()=>{
 vi.useFakeTimers();
 api={settingsSnapshot:vi.fn().mockRejectedValue('m'),environment:vi.fn().mockRejectedValue('m'),sessions:vi.fn().mockResolvedValue([{key,owned:true,path:'/mock/session'}]),runs:vi.fn().mockResolvedValue([]),archivedSessions:vi.fn().mockResolvedValue([]),onEvent:(fn:any)=>{emit=fn;},prompt:vi.fn(),history:vi.fn(),resolveSession:vi.fn().mockResolvedValue(key)};
 vi.stubGlobal('window',{localPi:api,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 vi.stubGlobal('document',{visibilityState:'visible',addEventListener:vi.fn(),removeEventListener:vi.fn()});
 usePiStore.getState().init();
});
beforeEach(async()=>{
 await vi.advanceTimersByTimeAsync(500);
 api.history.mockReset();
 usePiStore.setState({selectedKey:key,runs:[run],history:undefined,sends:[],pendingPrompt:undefined,pendingPromptAt:undefined,sentAt:undefined,pendingSteer:{},live:{},toolProgress:[],contextItems:[],draftText:'',connecting:false,changingAccessMode:false,error:undefined,leaf:undefined} as any);
});
afterAll(async()=>{await vi.advanceTimersByTimeAsync(500);vi.useRealTimers();vi.unstubAllGlobals();});

it('补拉后流式刷新保持已展开窗口（不被 tail 500 冲回）', async()=>{
 api.history
  .mockResolvedValueOnce(hist(mk(500)))
  .mockResolvedValueOnce(hist(mk(1000)))
  .mockResolvedValueOnce(hist(mk(1000))); // 刷新若带 before 锚点 count=0，应返回 1000 而非 500
 usePiStore.getState().selectSession(key);
 await vi.advanceTimersByTimeAsync(500);
 expect(usePiStore.getState().history!.branch.length).toBe(500);
 await usePiStore.getState().loadEarlierHistory();
 expect(usePiStore.getState().history!.branch.length).toBe(1000);
 // 记录刷新请求的参数，断言带了 before 锚点而非 tail
 emit({type:'rpc',key,generation:'g',event:{type:'message_start',message:{role:'user'}}});
 await vi.advanceTimersByTimeAsync(1000);
 const refreshCall = api.history.mock.calls[2];
 expect(refreshCall[2]).toMatchObject({ before: expect.any(String), count: 0 });
 expect(usePiStore.getState().history!.branch.length).toBe(1000);
},20000);
