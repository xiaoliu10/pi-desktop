import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import desktopMemory, { appendMemorySummary } from '../extensions/desktop-memory/index.mjs';
import { builtinMemoryDir, listMemoryFiles, projectMemoryFile, readMemoryFileContent } from '../src/main/pi/memory-bridge';
import { resolveMemoryOpen } from '../src/main/pi/memory-open';

const roots: string[] = [];
const temp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-'))); roots.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
const now = new Date('2026-09-27T12:34:56.000Z');

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
describe('desktop auto memory (temporary directories only)', () => {
  it('isolates two long common-prefix projects despite legacy collision, recursively lists/reads/opens daily', () => {
    const root = temp(), agent = temp(), dir = builtinMemoryDir(agent);
    const prefix = path.join(root, 'long-common-prefix-'.repeat(4));
    const a = path.join(prefix, 'alpha'), b = path.join(prefix, 'beta');
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b);
    const legacy = projectMemoryFile(agent, a), global = path.join(dir, 'daily', '2026-09-27.md');
    expect(legacy).toBe(projectMemoryFile(agent, b));
    write(legacy, 'old possibly shared legacy'); write(global, 'old global');
    const fileA = appendMemorySummary(dir, a, 'A only', now);
    const fileB = appendMemorySummary(dir, b, 'B only', now);
    appendMemorySummary(dir, a, 'A second', now);
    expect(fileA).toBe(path.join(a, '.pi/memory/daily/2026-09-27.md'));
    expect(fileB).toBe(path.join(b, '.pi/memory/daily/2026-09-27.md'));
    const rel = 'projects-external/daily/2026-09-27.md';
    expect(listMemoryFiles(agent, a).filter(f => f.rel.startsWith('projects-external/'))).toEqual([expect.objectContaining({ path: fileA, scope: 'project', rel, entries: 2 })]);
    expect(listMemoryFiles(agent, b).filter(f => f.rel.startsWith('projects-external/'))).toEqual([expect.objectContaining({ path: fileB, entries: 1 })]);
    expect(listMemoryFiles(agent).map(f => f.path).sort()).toEqual([global, legacy].sort());
    // 全局视图的旧版映射行： slug 能解出路径前缀但无已知项目 → 标注解码前缀，不丢失来源线索
    const legacyRow = listMemoryFiles(agent).find(f => f.rel.startsWith('projects/'))!;
    expect(legacyRow.project).toContain('/private/var/folders');
    expect(readMemoryFileContent(agent, rel, a)).toContain('A second');
    expect(readMemoryFileContent(agent, rel, a)).not.toContain('B only');
    expect(readMemoryFileContent(agent, rel, b)).toContain('B only');
    expect(readMemoryFileContent(agent, rel, b)).not.toContain('A only');
    expect(resolveMemoryOpen(agent, rel, a, [a, b])).toBe(fileA);
    expect(resolveMemoryOpen(agent, rel, b, [a, b])).toBe(fileB);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('old possibly shared legacy');
    expect(fs.readFileSync(global, 'utf8')).toBe('old global');
  });

  it.each([undefined, ''])('no project cwd (%s) retains explicit global daily behavior', cwd => {
    const agent = temp(), dir = builtinMemoryDir(agent);
    const file = appendMemorySummary(dir, cwd, 'global summary', now);
    expect(file).toBe(path.join(dir, 'daily', '2026-09-27.md'));
    expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false);
    expect(listMemoryFiles(agent)).toEqual([expect.objectContaining({ path: file, scope: 'global', entries: 1 })]);
    expect(listMemoryFiles(agent, temp())).toEqual([]);
  });

  it.each(['.pi', '.pi/memory', '.pi/memory/daily', '.pi/memory/daily/2026-09-27.md'])('rejects write escape at %s without touching the other project or global files', link => {
    const project = temp(), other = temp(), agent = temp();
    const target = link.endsWith('.md') ? path.join(other, 'secret.md') : other;
    if (link.endsWith('.md')) write(target, 'untouched');
    const alias = path.join(project, link);
    fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.symlinkSync(target, alias);
    expect(() => appendMemorySummary(builtinMemoryDir(agent), project, 'escaped', now)).toThrow();
    expect(fs.readdirSync(other)).toEqual(link.endsWith('.md') ? ['secret.md'] : []);
    if (link.endsWith('.md')) expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(fs.readdirSync(agent)).toEqual([]);
  });

  it('rejects missing/relative/invalid project cwd and never falls back to global', () => {
    const agent = temp();
    for (const cwd of [path.join(agent, 'missing'), './relative', null]) {
      expect(() => appendMemorySummary(builtinMemoryDir(agent), cwd, 'no fallback', now)).toThrow();
    }
    expect(fs.readdirSync(agent)).toEqual([]);
  });
});

function harness(result: () => Promise<any> = async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'synthetic recap' }] })) {
  const agent = temp(), cwd = temp();
  vi.stubEnv('PI_DESKTOP_MEMORY', '1'); vi.stubEnv('PI_DESKTOP_MEMORY_DIR', builtinMemoryDir(agent)); vi.stubEnv('PI_DESKTOP_MEMORY_CWD', cwd);
  const handlers: Record<string, Function> = {};
  desktopMemory({ on: (event: string, fn: Function) => { handlers[event] = fn; } });
  const streamSimple = vi.fn(() => ({ result }));
  const ctx = {
    isIdle: () => true, hasPendingMessages: () => false, model: { provider: 'fixture', id: 'fixture' },
    // Deliberately no getApiKey: removed in bundled 0.86.
    modelRegistry: { streamSimple },
    sessionManager: { getBranch: () => ['one', 'two', 'three', 'four'].map((text, i) => ({ type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text }] : text } })) },
  };
  return { agent, cwd, handlers, ctx, streamSimple };
}

describe('automatic recap lifecycle', () => {
  it('calls the configured registry after debounce, serializes string user messages and writes only project daily', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const h = harness();
    h.handlers.agent_end({}, h.ctx);
    await vi.advanceTimersByTimeAsync(19000); expect(h.streamSimple).not.toHaveBeenCalled();
    h.handlers.agent_end({}, h.ctx);
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.streamSimple).toHaveBeenCalledOnce();
    expect(h.streamSimple.mock.calls[0]).toEqual([h.ctx.model, expect.objectContaining({ messages: [expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining('User: one') })] })] }), expect.objectContaining({ reasoning: 'low', signal: expect.any(AbortSignal) })]);
    const files = listMemoryFiles(h.agent, h.cwd);
    expect(files).toHaveLength(1); expect(readMemoryFileContent(h.agent, files[0].rel, h.cwd)).toContain('synthetic recap');
    expect(fs.readdirSync(h.agent)).toEqual([]);
    h.handlers.agent_end({}, h.ctx); await vi.advanceTimersByTimeAsync(20000);
    expect(h.streamSimple).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'aborted', 'toolUse'])('does not persist a %s response even with partial text', async stopReason => {
    vi.useFakeTimers(); const h = harness(async () => ({ stopReason, content: [{ type: 'text', text: 'partial' }] }));
    h.handlers.agent_end({}, h.ctx); await vi.advanceTimersByTimeAsync(20000);
    expect(fs.readdirSync(h.cwd)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts in-flight calls on timeout and shutdown, ignores late completions', async () => {
    vi.useFakeTimers(); let resolve!: (v: any) => void;
    const h = harness(() => new Promise(r => { resolve = r; }));
    h.handlers.agent_end({}, h.ctx); await vi.advanceTimersByTimeAsync(20000);
    const signal = (h.streamSimple.mock.calls[0] as any)[2].signal;
    await vi.advanceTimersByTimeAsync(60000); expect(signal.aborted).toBe(true);
    resolve({ stopReason: 'stop', content: [{ type: 'text', text: 'too late' }] });
    await vi.advanceTimersByTimeAsync(0); expect(fs.readdirSync(h.cwd)).toEqual([]);
    await vi.advanceTimersByTimeAsync(60000);
    h.handlers.agent_end({}, h.ctx); await vi.advanceTimersByTimeAsync(20000);
    h.handlers.session_shutdown(); expect((h.streamSimple.mock.calls[1] as any)[2].signal.aborted).toBe(true);
    resolve({ stopReason: 'stop', content: [{ type: 'text', text: 'after shutdown' }] });
    await vi.advanceTimersByTimeAsync(0); expect(fs.readdirSync(h.cwd)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not run while busy, disabled, or after shutdown', async () => {
    vi.useFakeTimers(); const h = harness();
    h.handlers.agent_end({}, { ...h.ctx, isIdle: () => false }); await vi.advanceTimersByTimeAsync(20000);
    h.handlers.agent_end({}, h.ctx); h.handlers.session_shutdown(); await vi.advanceTimersByTimeAsync(20000);
    expect(h.streamSimple).not.toHaveBeenCalled();
    vi.stubEnv('PI_DESKTOP_MEMORY', ''); const on = vi.fn(); desktopMemory({ on }); expect(on).not.toHaveBeenCalled();
  });
});
