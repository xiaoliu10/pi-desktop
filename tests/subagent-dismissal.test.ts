import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationStatusPanel } from '../src/renderer/pi/ConversationStatusPanel';
import { dismissibleSubagentIds } from '../src/renderer/pi/subagent-dismissal';
import { projectSubagents, type ChildState, type SubagentChild } from '../src/renderer/pi/subagents';
import { registerSubagentAdapter } from '../src/renderer/pi/subagent-registry';
import { sentConversationMessages, usePiStore } from '../src/renderer/pi/adapter';
import { SettingsService } from '../src/main/pi/settings-service';
import type { PiEvent, PiHistory, PiRun } from '../src/shared/pi';

const child = (status: ChildState, callId: string = status): SubagentChild => ({ id: `${callId}:${status}`, callId, status, agent: status, task: `${status} task`, mode: 'single', messages: [] });
const statuses: ChildState[] = ['running', 'queued', 'completed', 'failed', 'interrupted', 'recovered', 'skipped', 'unknown'];
// A plugin may report live children independently of the parent process state.
registerSubagentAdapter({ id: 'dismissal-test', detect: part => part.tool === 'dismissal-fixture', parse: part => part.resultDetails as SubagentChild[] });
const history = (children: SubagentChild[]): PiHistory => ({ branch: [
  { type: 'message', id: `call-${children.map(c => c.id).join()}`, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'fixture', name: 'dismissal-fixture', arguments: {} }] } },
  { type: 'message', id: `result-${children.map(c => c.id).join()}`, message: { role: 'toolResult', toolCallId: 'fixture', toolName: 'dismissal-fixture', content: [], details: children } },
] } as PiHistory);
const run: PiRun = { key: 'a', generation: 'g', status: 'idle', cwd: '/mock', file: '/mock/a.jsonl', models: [], commands: [], pending: 0 };
let root: string;
let service: SettingsService;
let api: { saveDesktopSettings: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> };
const initial = usePiStore.getState();
beforeEach(() => {
  vi.useFakeTimers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dismissal-')));
  service = new SettingsService({} as never, root, '');
  service.savePreferences({ subagentDismissed: { b: ['keep-hidden'] } });
  api = { saveDesktopSettings: vi.fn(async patch => service.savePreferences(patch)), history: vi.fn(async () => history(statuses.map(s => child(s)))) };
  vi.stubGlobal('window', { localPi: api, innerWidth: 1280, confirm: () => true });
  vi.stubGlobal('localStorage', { getItem: () => null });
  usePiStore.setState({ ...initial, selectedKey: 'a', runs: [run], history: history(statuses.map(s => child(s))), desktopPreferences: service.preferences(), subagentDismissed: undefined, recoveredSubagents: [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); usePiStore.setState(initial, true); fs.rmSync(root, { recursive: true, force: true }); });
const visible = () => {
  const s = usePiStore.getState(), key = s.selectedKey!;
  const dismissed = s.subagentDismissed ?? s.desktopPreferences?.subagentDismissed?.[key] ?? [];
  return projectSubagents(sentConversationMessages(s.history?.branch ?? [], s.live[key], s.toolProgress[key], []), false, s.recoveredSubagents).filter(c => !dismissed.includes(c.id) && !dismissed.includes(c.callId));
};

describe('task board finished-only dismissal', () => {
  it.each(statuses)('only offers %s removal when finished, even if parent idle', status => {
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, { messages: [], running: false, onReview() {}, onRequest() {}, onOpenSubagent() {}, onDismissSubagent() {}, onDismissFinishedSubagents() {}, subagents: [child(status)] }));
    const finished = !['running', 'queued'].includes(status);
    expect(html.includes('pi-status-agent-remove')).toBe(finished);
    expect(html.includes('清空已结束')).toBe(finished);
    expect(html).toContain(finished ? '1 已结束' : '1 运行 · 0 已结束');
    if (finished) expect(html).toMatch(/<\/button><button type="button" class="pi-status-agent-remove"/);
  });

  it('removes a single failed child while its sibling keeps running (was: whole call locked)', () => {
    const children = [child('completed', 'chain'), child('running', 'chain'), child('failed', 'parallel'), child('queued', 'parallel'), child('completed', 'done'), child('failed', 'done')];
    // Child-level granularity: every ended child is individually removable — a
    // running/queued sibling no longer locks the ended rows of the same call.
    expect(dismissibleSubagentIds(children)).toEqual(['chain:completed', 'parallel:failed', 'done:completed', 'done:failed']);
    usePiStore.setState({ history: history(children) });
    usePiStore.getState().dismissFinishedSubagents(['chain:completed', 'parallel:failed', 'done:completed', 'missing']);
    expect(usePiStore.getState().subagentDismissed).toEqual(['chain:completed', 'parallel:failed', 'done:completed']);
    const left = visible();
    expect(left.map(c => c.id)).toEqual(['chain:running', 'parallel:queued', 'done:failed']); // live siblings untouched, unlisted row kept
  });
  it('legacy whole-callId entries keep hiding the entire call (backward compatible)', () => {
    usePiStore.setState({ subagentDismissed: ['done'] });
    usePiStore.setState({ history: history([child('completed', 'done'), child('failed', 'done'), child('running', 'chain')]) });
    expect(visible().map(c => c.callId)).toEqual(['chain']); // 旧条目按 callId 匹配整调用
  });
  it('single removal persists only ended records, leaves source history and run untouched', () => {
    const before = usePiStore.getState();
    const source = path.join(root, 'source.jsonl'); fs.writeFileSync(source, JSON.stringify(before.history));
    usePiStore.getState().dismissSubagent('running:running');
    usePiStore.getState().dismissSubagent('queued:queued');
    usePiStore.getState().dismissSubagent('missing');
    expect(api.saveDesktopSettings).not.toHaveBeenCalled();
    usePiStore.getState().dismissSubagent('completed:completed');
    usePiStore.getState().dismissSubagent('completed:completed');
    expect(api.saveDesktopSettings).toHaveBeenCalledTimes(1);
    expect(service.preferences().subagentDismissed).toEqual({ a: ['completed:completed'], b: ['keep-hidden'] });
    expect(visible()).toHaveLength(7);
    expect(usePiStore.getState().history).toBe(before.history);
    expect(usePiStore.getState().runs).toBe(before.runs);
    expect(fs.readFileSync(source, 'utf8')).toBe(JSON.stringify(before.history));
  });
  it('bulk intersects current-session records, is idempotent, and never removes live children', () => {
    usePiStore.getState().dismissFinishedSubagents([...statuses.map(s => `${s}:${s}`), 'other-session-only']);
    expect(usePiStore.getState().subagentDismissed).toEqual(statuses.slice(2).map(s => `${s}:${s}`));
    expect(visible().map(c => c.status)).toEqual(['running', 'queued']);
    expect(service.preferences().subagentDismissed?.b).toEqual(['keep-hidden']);
    usePiStore.getState().dismissFinishedSubagents(statuses.map(s => `${s}:${s}`));
    expect(api.saveDesktopSettings).toHaveBeenCalledTimes(1);
  });
  it('revalidates a finished row which became live before its click', () => {
    usePiStore.setState({ history: history([child('running', 'completed')]) });
    usePiStore.getState().dismissSubagent('completed:completed');
    expect(api.saveDesktopSettings).not.toHaveBeenCalled();
  });
  it('restores hidden IDs across history refresh, switching, and settings-service restart', async () => {
    usePiStore.getState().dismissSubagent('completed:completed');
    usePiStore.getState().selectSession('b');
    expect(usePiStore.getState().subagentDismissed).toEqual(['keep-hidden']);
    await vi.advanceTimersByTimeAsync(500);
    expect(visible().some(c => c.callId === 'completed')).toBe(true);
    // Same callId in b is unaffected; stale a-only ids cannot be dismissed in b.
    usePiStore.getState().dismissSubagent('a-only:0');
    expect(service.preferences().subagentDismissed?.b).toEqual(['keep-hidden']);
    usePiStore.getState().selectSession('a');
    await vi.advanceTimersByTimeAsync(500);
    expect(visible().some(c => c.callId === 'completed')).toBe(false);
    const restarted = new SettingsService({} as never, root, '');
    usePiStore.setState({ desktopPreferences: restarted.preferences(), subagentDismissed: undefined, history: history(statuses.map(s => child(s))) });
    expect(visible().some(c => c.callId === 'completed')).toBe(false);
    expect(visible().filter(c => ['running', 'queued'].includes(c.status))).toHaveLength(2);
  });
  it('also persists recovered-only records without changing snapshots', () => {
    const recovered = [{ callId: 'disk-only', status: 'interrupted' }];
    usePiStore.setState({ recoveredSubagents: recovered });
    usePiStore.getState().dismissSubagent('disk-only:0');
    expect(service.preferences().subagentDismissed?.a).toEqual(['disk-only:0']);
    expect(usePiStore.getState().recoveredSubagents).toBe(recovered);
    expect(visible().some(c => c.callId === 'disk-only')).toBe(false);
  });
  it('does not import a late/background recovery snapshot into another session or new generation', async () => {
    let emit!: (event: PiEvent) => void;
    let recover!: (value: unknown[]) => void;
    Object.assign(api, {
      settingsSnapshot: async () => ({ preferences: service.preferences() }),
      environment: async () => { throw new Error('fixture: no runtime'); },
      sessions: async () => [], runs: async () => [], archivedSessions: async () => [],
      onEvent: (listener: typeof emit) => { emit = listener; },
      recoverSubagents: () => new Promise(resolve => { recover = resolve; }),
    });
    usePiStore.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    for (const mode of ['switch', 'background', 'generation', 'current']) {
      usePiStore.setState({ selectedKey: mode === 'background' ? 'b' : 'a', runs: [run], recoveredSubagents: [], subagentDismissed: undefined });
      emit({ type: 'closed', key: 'a', generation: run.generation });
      if (mode === 'switch') usePiStore.getState().selectSession('b');
      if (mode === 'generation') usePiStore.setState({ runs: [{ ...run, generation: 'new' }] });
      recover([{ callId: 'late-disk', status: 'interrupted' }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(usePiStore.getState().recoveredSubagents).toHaveLength(mode === 'current' ? 1 : 0);
      usePiStore.getState().dismissSubagent('late-disk:0');
      expect(service.preferences().subagentDismissed?.b).toEqual(['keep-hidden']);
    }
    expect(service.preferences().subagentDismissed?.a).toEqual(['late-disk:0']);
  });
  it('wires board actions to the existing store callbacks', () => {
    const app = fs.readFileSync(new URL('../src/renderer/pi/PiReplicaApp.tsx', import.meta.url), 'utf8');
    expect(app).toContain('onDismissSubagent={s.dismissSubagent} onDismissFinishedSubagents={s.dismissFinishedSubagents}');
  });
});

describe('running-subagent guard on leaving a session', () => {
  const withLive = (status: ChildState) => {
    usePiStore.setState({ selectedKey: 'a', runs: [{ ...run, status: 'running' }], history: history([child(status)]), recoveredSubagents: [], subagentDismissed: undefined });
  };
  // 断开会话会杀掉持有子代理的 pi 进程：有 running/queued 时必须先确认，
  // 否则用户在不知情的情况下离开就会永久丢失子代理（真实痛点）。
  it('blocks switching and disconnecting while a subagent is live, and allows it after settlement', async () => {
    vi.stubGlobal('window', { localPi: { close: vi.fn(async () => undefined) }, innerWidth: 1280, confirm: vi.fn(() => false) });
    const close = (window as unknown as { localPi: { close: ReturnType<typeof vi.fn> } }).localPi.close;
    for (const status of ['running', 'queued'] as ChildState[]) {
      withLive(status);
      const store = usePiStore.getState();
      expect(store.liveSubagentCount()).toBe(1);
      store.selectSession('b');
      expect(usePiStore.getState().selectedKey).toBe('a'); // 用户取消 → 不切换
      store.disconnectRun('a');
      await vi.advanceTimersByTimeAsync(0);
      expect(close).not.toHaveBeenCalled();
      expect((window as unknown as { confirm: ReturnType<typeof vi.fn> }).confirm).toHaveBeenCalled();
    }
    // 用户确认 → 放行
    vi.stubGlobal('window', { localPi: { close }, innerWidth: 1280, confirm: vi.fn(() => true) });
    withLive('running');
    usePiStore.getState().disconnectRun('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledWith('a');
  });
  it('never blocks on finished subagents', async () => {
    vi.stubGlobal('window', { localPi: { close: vi.fn(async () => undefined) }, innerWidth: 1280, confirm: vi.fn(() => false) });
    const close = (window as unknown as { localPi: { close: ReturnType<typeof vi.fn> } }).localPi.close;
    for (const status of ['completed', 'failed', 'interrupted', 'recovered', 'skipped', 'unknown'] as ChildState[]) {
      withLive(status);
      expect(usePiStore.getState().liveSubagentCount()).toBe(0);
    }
    withLive('completed');
    usePiStore.getState().disconnectRun('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledWith('a'); // 无确认直接放行
  });
});
