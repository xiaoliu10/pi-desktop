import React from 'react';
import { createRoot } from 'react-dom/client';
import PiReplicaApp from '../../src/renderer/pi/PiReplicaApp';
import { usePiStore } from '../../src/renderer/pi/adapter';
import type { LocalPiApi, PiEvent, PiHistory, PiRun } from '../../src/shared/pi';
import '../../src/renderer/styles.css';

window.addEventListener('error', event => {
  const holder = window.__fixtureErrors ?? (window.__fixtureErrors = []);
  holder.push(`${event.message}\n${event.filename}:${event.lineno}`);
});
window.addEventListener('unhandledrejection', event => {
  const holder = window.__fixtureErrors ?? (window.__fixtureErrors = []);
  holder.push(`unhandled rejection: ${event.reason?.stack ?? event.reason}`);
});

const model = { provider: 'test', id: 'test-model', name: '测试模型（无网络）', reasoning: true, contextWindow: 128000, maxTokens: 4096 };
let run = { key: 'retry-ui-fixture', generation: 'retry-ui-generation', cwd: '/mock/retry-ui', file: '/mock/retry-ui/session.jsonl', status: 'running', model, models: [model], commands: [], pending: 0, timing: { startedAt: Date.now() - 10000 } } as PiRun;
const session = { key: run.key, file: run.file, cwd: run.cwd, title: '重试界面验证（模拟数据）', updatedAt: Date.now(), source: 'desktop' as const };
const failure = (n: number) => ({
  type: 'message', id: `fixture-error-${n}`, timestamp: new Date(Date.now() - 5000 + n * 100).toISOString(),
  message: { role: 'assistant', content: [], provider: model.provider, model: model.id, timestamp: Date.now() - 5000 + n * 100, stopReason: 'error', errorMessage: 'fetch failed', diagnostics: [{ type: 'test', error: { message: 'Simulated connection error', code: 'ECONNRESET' }, details: { requestId: `test-${n}` } }] },
});
const branch = [
  { type: 'message', id: 'fixture-user', timestamp: new Date(Date.now() - 12000).toISOString(), message: { role: 'user', content: '测试重复错误合并与自动重试。这是模拟数据，不会调用模型。' } },
  ...[1, 2, 3, 4].map(failure),
  { type: 'message', id: 'fixture-agent-call', timestamp: new Date(Date.now() - 4000).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'sub-call', name: 'subagent', arguments: { tasks: [{ agent: 'explorer-1', task: '查找相关源码' }, { agent: 'reviewer-1', task: '审阅重试修复' }] } }] } },
  { type: 'message', id: 'fixture-agent-result', timestamp: new Date(Date.now() - 3000).toISOString(), message: { role: 'toolResult', toolCallId: 'sub-call', toolName: 'subagent', content: [{ type: 'text', text: '2 个子代理已完成' }], isError: false, details: { mode: 'parallel', results: [{ agent: 'explorer-1', task: '查找相关源码', exitCode: 0, messages: [] }, { agent: 'reviewer-1', task: '审阅重试修复', exitCode: 0, messages: [] }] } } },
];
const history = { session, branch, entries: branch, leaves: [], leafId: 'fixture-error-4', syncedAt: Date.now() } as unknown as PiHistory;
const preferences = { projects: [], shortcuts: {}, permission: 'ask', behavior: 'followUp' };
window.__fixtureMcpSaves = [] as Array<Record<string, unknown>>;
let emit: (event: PiEvent) => void = () => {};
let stops = 0;
const rpc = (event: Record<string, unknown>) => emit({ type: 'rpc', key: run.key, generation: run.generation, event });
const settle = () => {
  run = { ...run, status: 'idle', timing: { startedAt: run.timing!.startedAt, endedAt: Date.now() } };
  emit({ type: 'run', run });
  rpc({ type: 'agent_settled' });
};
window.localPi = {
  onEvent: listener => { emit = listener; return () => {}; },
  settingsSnapshot: async () => ({ preferences, ai: {}, mcp: [
    { id: 'mcp-fixture-direct', name: 'my-server', scope: 'user', transport: 'stdio', target: 'npx', enabled: true, path: '/mock/mcp.json', revision: 'r1' },
    { id: 'mcp-fixture-import', name: 'computer-use', scope: 'user', transport: 'stdio', target: 'SkyComputerUseClient', enabled: false, path: '/Users/mock/.codex/config.toml', revision: 'r1', source: 'codex' },
  ], mcpRevisions: { user: 'r1', project: 'r1' }, resources: [], diagnostics: [], projects: [], loadedExtensions: [] }),
  mcpSave: async (input: Record<string, unknown>) => { window.__fixtureMcpSaves.push(input); },
  mcpTest: async () => ({ tools: ['echo'] }),
  resourceRead: async () => ({ text: '', path: '', kind: 'skills', name: 'x', editable: true }),
  environment: async () => ({ supported: true, version: '0.87.0', agentDir: '/mock', sessionDirs: [] }),
  sessions: async () => [session], runs: async () => [run], archivedSessions: async () => [],
  history: async () => history, resources: async () => [], modelCatalog: async () => ({ providers: [], defaults: {} }),
  packageList: async () => [], recoverSubagents: async () => [],
  gitStatus: async () => ({ repository: false, branch: 'main', branches: [], untracked: 0, ahead: 0, behind: 0 }),
  voiceConfig: async () => ({ enabled: false, models: [] }),
  projectBranch: async () => null,
  externalApps: async () => [],
  terminalCreate: async () => ({ id: 'fixture-term', cwd: '/mock/retry-ui', cols: 80, rows: 24 }),
  terminalWrite: async () => {}, terminalResize: async () => {}, terminalKill: async () => {},
  onTerminalData: () => () => {}, onTerminalExit: () => () => {},
  stop: async () => {
    stops++;
    return { steering: [], followUp: [] };
  },
} as unknown as LocalPiApi;
usePiStore.getState().init();
// 内嵌验证浏览器 innerWidth 上报 0 会触发窄屏自动折叠：改写为常规桌面宽度以便核对面板区块。
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
localStorage.setItem('pi-status-collapsed', 'false');
// 注入计划快照：状态面板「计划」区有数据才会渲染（点击在右侧打开 PlanViewer）。
localStorage.setItem('pi-plan-snapshots', JSON.stringify({ 'retry-ui-fixture': '# 重试界面验证计划\n\n1. 合并同轮重复错误\n2. 底部展示重试次数与倒计时\n3. 点击查看在右侧展示' }));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
usePiStore.setState({ ready: true, lang: 'zh', view: 'chat', selectedKey: run.key, runs: [run], sessions: [session as never], history, notifications: [], live: {}, sends: [], connecting: false, contextItems: [], draftText: '', error: undefined, desktopPreferences: preferences as never, workbenchOpen: false, toolProgress: { [run.key]: [{ turnId: 'history:fixture-user', toolCallId: 'sub-live', name: 'subagent', text: '监控测试输出', status: 'running', phase: 'progress' as const, argumentsText: '{"tasks":[{"agent":"watcher-1","task":"盯测试输出"}]}', details: { mode: 'parallel', results: [{ agent: 'watcher-1', task: '盯测试输出', exitCode: 0, messages: [] }] } }] } as never });
const retry = () => {
  run = { ...run, status: 'running', timing: { startedAt: Date.now() } };
  emit({ type: 'run', run });
  rpc({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 8000, errorMessage: 'fetch failed' });
};
const fail = () => { rpc({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'fetch failed' }); settle(); };
function Fixture() {
  return <><div style={{ height: 38, display: 'flex', gap: 12, alignItems: 'center', padding: '0 12px', color: '#333', background: '#f0f0f0', font: '12px system-ui' }}>
    <strong>隔离验证 · 模拟数据</strong><button onClick={retry}>模拟网络重试</button><button onClick={fail}>模拟重试耗尽</button><button onClick={() => usePiStore.getState().setTheme(usePiStore.getState().theme === 'dark' ? 'light' : 'dark')}>切换验证主题</button>
  </div><div style={{ height: 'calc(100vh - 38px)' }}><PiReplicaApp /></div></>;
}
retry();
createRoot(document.getElementById('root')!).render(<Fixture />);
