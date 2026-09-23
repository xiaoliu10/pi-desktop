import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePiStore } from '../src/renderer/pi/adapter';
import type { PiRun } from '../src/shared/pi';
const run: PiRun = { key: 'desktop-run', generation: 'g1', cwd: '/project', file: '/sessions/desktop/new.jsonl', status: 'idle', models: [], commands: [], pending: 0 };
let api: { connect: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn>; pickDirectory: ReturnType<typeof vi.fn>; model: ReturnType<typeof vi.fn>; thinking: ReturnType<typeof vi.fn> };
beforeEach(() => {
 api = { model: vi.fn().mockResolvedValue(undefined), thinking: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(run), prompt: vi.fn().mockResolvedValue(undefined), history: vi.fn().mockRejectedValue(new Error('not written yet')), pickDirectory: vi.fn().mockResolvedValue('/chosen'), saveDesktopSettings: vi.fn().mockResolvedValue(undefined) };
 vi.stubGlobal('window', { localPi: api });
 usePiStore.setState({ selectedKey: null, sessions: [], runs: [], connecting: false, contextItems: [], draftModelId: undefined, draftThinking: undefined, draftCwd: '/project', draftText: '', pendingPrompt: undefined, error: undefined, history: undefined, desktopPreferences: undefined, env: { supported: true, executable: '/pi', agentDir: '/agent', sessionDirs: [], version: '0.85.1', diagnostics: [] } });
});
afterEach(() => vi.unstubAllGlobals());
it('starts a Desktop-owned runtime and sends the first prompt without a connect dialog', async () => {
 usePiStore.getState().send('implement feature');
 await vi.waitFor(() => expect(api.prompt).toHaveBeenCalledWith(run.key, 'implement feature', 'followUp'));
 expect(api.connect).toHaveBeenCalledWith({ cwd: '/project', sourceKey: undefined, trustProject: false, permission: 'ask' });
 expect(usePiStore.getState().selectedKey).toBe(run.key);
 expect(api.pickDirectory).not.toHaveBeenCalled();
});
it('continues history automatically through the safe copy path', async () => {
 usePiStore.setState({ selectedKey: 'cli-history' });
 usePiStore.getState().send('continue');
 await vi.waitFor(() => expect(api.prompt).toHaveBeenCalled());
 expect(api.connect.mock.calls[0][0]).toMatchObject({ sourceKey: 'cli-history', cwd: undefined });
});
it('reuses an active runtime without connecting again', async () => {
 usePiStore.setState({ selectedKey: run.key, runs: [run] });
 usePiStore.getState().send('next');
 await vi.waitFor(() => expect(api.prompt).toHaveBeenCalled());
 expect(api.connect).not.toHaveBeenCalled();
});
it('restores the prompt if directory selection is cancelled or startup fails', async () => {
 usePiStore.setState({ draftCwd: undefined }); api.pickDirectory.mockResolvedValue(null);
 usePiStore.getState().send('keep this text');
 await vi.waitFor(() => expect(usePiStore.getState().connecting).toBe(false));
 expect(usePiStore.getState().draftText).toBe('keep this text'); expect(api.connect).not.toHaveBeenCalled();
 usePiStore.setState({ draftCwd: '/project' }); api.connect.mockRejectedValue(new Error('missing model'));
 usePiStore.getState().send('retry this');
 await vi.waitFor(() => expect(usePiStore.getState().error).toBe('missing model'));
 expect(usePiStore.getState().draftText).toBe('retry this');
});
it('deduplicates submissions while the runtime starts', async () => {
 let resolve!: (r: PiRun) => void;
 api.connect.mockImplementation(() => new Promise<PiRun>(r => { resolve = r; }));
 usePiStore.getState().send('once'); usePiStore.getState().send('duplicate');
 expect(api.connect).toHaveBeenCalledTimes(1);
 resolve(run);
 await vi.waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1));
});
it('new task opens a composer using the current project without launching a process', () => {
 usePiStore.setState({ selectedKey: run.key, runs: [run] });
 usePiStore.getState().startNewSession();
 expect(usePiStore.getState()).toMatchObject({ selectedKey: null, view: 'home', draftCwd: '/project' });
 expect(api.connect).not.toHaveBeenCalled(); expect(api.pickDirectory).not.toHaveBeenCalled();
});

it('sends selected context and applies draft model and thinking before the first prompt',async()=>{
 usePiStore.getState().addContext([{id:'doc',name:'notes.md',path:'/project/notes.md',kind:'document',text:'Reference contents'}]);
 usePiStore.getState().pickModel('provider/model/with/slashes');usePiStore.getState().pickThinking('high');
 usePiStore.getState().send('Summarize');
 await vi.waitFor(()=>expect(api.prompt).toHaveBeenCalled());
 expect(api.model).toHaveBeenCalledWith(run.key,'provider','model/with/slashes');
 expect(api.thinking).toHaveBeenCalledWith(run.key,'high');
 expect(api.prompt.mock.calls[0][1]).toContain('Reference contents');
 expect(usePiStore.getState().contextItems).toEqual([]);
});
it('restores attachments after a failed send',async()=>{
 const context={id:'doc',name:'notes.md',path:'/project/notes.md',kind:'document' as const,text:'Reference contents'};
 usePiStore.getState().addContext([context]);api.prompt.mockRejectedValue(new Error('offline'));
 usePiStore.getState().send('retry later');
 await vi.waitFor(()=>expect(usePiStore.getState().error).toBe('offline'));
 expect(usePiStore.getState().contextItems).toEqual([context]);expect(usePiStore.getState().draftText).toBe('retry later');
});

it('sends image-only attachments as native pi image blocks and preserves them on failure',async()=>{
 const image={type:'image' as const,mimeType:'image/png',data:'aGVsbG8='};
 const context={id:'image',name:'clipboard.png',path:'',kind:'image' as const,text:'',image};
 usePiStore.getState().addContext([context]);api.prompt.mockRejectedValue(new Error('model has no vision'));
 usePiStore.getState().send('');
 await vi.waitFor(()=>expect(api.prompt).toHaveBeenCalledWith(run.key,'请查看所附文件。','followUp',[image]));
 await vi.waitFor(()=>expect(usePiStore.getState().error).toBe('model has no vision'));
 expect(usePiStore.getState().contextItems).toEqual([context]);
 api.prompt.mockResolvedValue(undefined);usePiStore.getState().send('describe image');
 await vi.waitFor(()=>expect(usePiStore.getState().contextItems).toEqual([]));
 expect(api.prompt.mock.calls.at(-1)?.[1]).toBe('describe image');
});

it('submits follow-ups while the current runtime is still running',async()=>{
 usePiStore.setState({selectedKey:run.key,runs:[{...run,status:'running'}]});
 usePiStore.getState().send('next question');
 await vi.waitFor(()=>expect(api.prompt).toHaveBeenCalledWith(run.key,'next question','followUp'));
 expect(api.connect).not.toHaveBeenCalled();
});
