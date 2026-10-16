import { describe, expect, it } from 'vitest';
import { completionsDetails } from '../src/shared/subagent-workflow';

// pi-subagents >=0.79 的第三种结果形态（真实样本，来自用户会话 1790689427…）：
// run 结束后 tool result 只带 {token, runId, outcome, completions:[{agent, mode:'single',
// state:'complete', success, results:[{agent, sessionFile, outputState, …}], archivePath}]}。
// 此前后两种识别（workflowDetails/singleAsyncDetails）都不认它 → 子代理详情面板
// 拿不到 childKey → 永久转圈/「转录不可用」。completionsDetails 负责解析这层。

const REAL = {
  token: '4a588506-456a-48c7-80c0-809cc3f6cc56',
  runId: '429b10a0-15da-4019-891f-406ba6695561',
  outcome: 'completed',
  completions: [{
    runId: '429b10a0-15da-4019-891f-406ba6695561',
    agent: 'code-reviewer',
    mode: 'single',
    state: 'complete',
    success: true,
    results: [{ agent: 'code-reviewer', usage: {}, sessionFile: '/Users/jason/.pi/agent/sessions/desktop/1790689427762_5e3a1092/cd6fcb4a/run-0/session.jsonl', success: true, outputState: 'complete', model: 'ccr-opus', artifactPaths: [] }],
    archivePath: '/var/folders/…/output-archives/429b10a0.json',
  }],
};

describe('completionsDetails：第三种结果形态', () => {
  it('解析出 sessionFile 指针与 runId（真实样本）', () => {
    const d = completionsDetails(REAL, 'call_abc');
    expect(d).toBeDefined();
    expect(d!.sessionFile).toContain('cd6fcb4a');
    expect(d!.runId).toBe('429b10a0-15da-4019-891f-406ba6695561');
    expect(d!.mode).toBe('single');
    expect(d!.state).toBe('complete');
  });
  it('callId 不匹配时拒绝（防串到别的调用）', () => {
    expect(completionsDetails({ ...REAL, toolCallId: 'call_other' }, 'call_abc')).toBeUndefined();
  });
  it('completion 级 toolCallId 不匹配时跳过该 completion', () => {
    const multi = { runId: 'r1', completions: [{ ...REAL.completions[0], toolCallId: 'call_x' }] };
    expect(completionsDetails(multi, 'call_abc')).toBeUndefined();
  });
  it('无 sessionFile 的 completion 不产出指针', () => {
    const noFile = { runId: 'r1', completions: [{ runId: 'r1', mode: 'single', state: 'complete', results: [{ agent: 'x' }] }] };
    expect(completionsDetails(noFile, 'call_abc')).toBeUndefined();
  });
  it('非 single mode 的 completion 不认', () => {
    const wf = { runId: 'r1', completions: [{ runId: 'r1', mode: 'workflow', state: 'complete', results: [{ sessionFile: '/x' }] }] };
    expect(completionsDetails(wf, 'call_abc')).toBeUndefined();
  });
  it('completions 缺失/为空/非对象 → undefined（不误判普通结果）', () => {
    expect(completionsDetails({ runId: 'r1' }, 'c')).toBeUndefined();
    expect(completionsDetails({ runId: 'r1', completions: [] }, 'c')).toBeUndefined();
    expect(completionsDetails(null, 'c')).toBeUndefined();
    expect(completionsDetails('x', 'c')).toBeUndefined();
  });
  it('runId 缺失时回退顶层 runId；都缺则拒绝', () => {
    const noChildRun = { runId: 'top1', completions: [{ mode: 'single', state: 'complete', results: [{ sessionFile: '/x' }] }] };
    expect(completionsDetails(noChildRun, 'c')!.runId).toBe('top1');
    expect(completionsDetails({ completions: [{ mode: 'single', results: [{ sessionFile: '/x' }] }] }, 'c')).toBeUndefined();
  });
  it('多 completion 时取第一个带 sessionFile 的', () => {
    const multi = { runId: 'r1', completions: [
      { runId: 'a', mode: 'single', state: 'complete', results: [] },
      { runId: 'b', mode: 'single', state: 'complete', results: [{ sessionFile: '/second' }] },
    ] };
    expect(completionsDetails(multi, 'c')!.sessionFile).toBe('/second');
  });
});
