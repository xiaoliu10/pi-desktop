import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { SidecarService } from '../src/main/pi/sidecar-service';
import type { PiEvent } from '../src/shared/pi';

const roots: string[] = [], backends: PiBackend[] = [], indexes: SessionIndex[] = [];
afterEach(() => {
  backends.splice(0).forEach(b => b.dispose());
  indexes.splice(0).forEach(i => i.close());
  roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true }));
});
function setup(lazy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sidecar-mvp-')); roots.push(root);
  const owned = path.join(root, 'desktop'), data = path.join(root, 'data'); fs.mkdirSync(owned);
  const main = path.join(owned, 'sidecar-mvp-main.jsonl');
  fs.writeFileSync(main, JSON.stringify({ type: 'session', version: 3, id: 'sidecar-mvp-main-header', cwd: root }) + '\n');
  const index = new SessionIndex([owned], owned); indexes.push(index);
  const events: PiEvent[] = [];
  const emit = (e: PiEvent) => events.push(structuredClone(e));
  const backend = new PiBackend({ executable: lazy ? process.execPath : path.resolve('tests/fixtures/fake-pi.mjs'), ...(lazy ? { launchArgs: [path.resolve('tests/fixtures/lazy-pi.mjs')] } : {}), supported: true, version: '0.85.1', agentDir: root, sessionDirs: [owned], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), emit, data);
  backends.push(backend);
  return { root, owned, data, index, events, backend, main, mainKey: fileKey(main), service: new SidecarService(backend, index, data, emit), emit };
}

describe('retained sidecar service', () => {
  it('makes empty history immediately readable and keeps repeated ensures on the same generation with a lazy runtime', async () => {
    const { service, backend, mainKey, index, root } = setup(true);
    const connect = vi.spyOn(backend, 'connect');
    const first = await service.ensure(mainKey);
    const raw = fs.readFileSync(first.file, 'utf8');
    const header = JSON.parse(raw);
    expect(header).toEqual({ type: 'session', version: 3, id: expect.any(String), timestamp: expect.any(String), cwd: root });
    expect(header.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    expect(Number.isFinite(Date.parse(header.timestamp))).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(first.file).mode & 0o777).toBe(0o600);
    expect(index.history(first.key)).toMatchObject({ entries: [], branch: [], leaves: [], leafId: null });
    expect((await service.ensure(mainKey)).generation).toBe(first.generation);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(backend.runs()).toHaveLength(1);
    expect(index.scan().map(s => s.key)).toEqual([mainKey]);
    expect(fs.readFileSync(first.file, 'utf8')).toBe(raw);
  });

  it('resumes the exact empty file and persisted binding after a backend/index restart', async () => {
    const { service, backend, mainKey, data, owned, root, index, emit } = setup(true);
    const first = await service.ensure(mainKey);
    const raw = fs.readFileSync(first.file, 'utf8');
    backend.dispose(); index.close();
    const restartedIndex = new SessionIndex([owned], owned); indexes.push(restartedIndex);
    const restartedBackend = new PiBackend({ executable: process.execPath, launchArgs: [path.resolve('tests/fixtures/lazy-pi.mjs')], supported: true, agentDir: root, sessionDirs: [owned], diagnostics: [] }, restartedIndex, owned, path.resolve('extensions/desktop-policy/index.mjs'), emit, data);
    backends.push(restartedBackend);
    const restored = new SidecarService(restartedBackend, restartedIndex, data, emit);
    expect(restored.bindingOf(mainKey)).toBe(first.key);
    const second = await restored.ensure(mainKey);
    expect(second.key).toBe(first.key);
    expect(second.file).toBe(first.file);
    expect(second.generation).not.toBe(first.generation);
    expect(restartedIndex.history(second.key)).toMatchObject({ entries: [], branch: [], leafId: null });
    expect(fs.readFileSync(second.file, 'utf8')).toBe(raw);
    expect((await restored.ensure(mainKey)).generation).toBe(second.generation);
  });

  it('leaves new main sessions lazy and does not persist an invalid auxiliary project', async () => {
    const { backend, root, owned, mainKey } = setup(true);
    const main = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
    expect(fs.existsSync(main.file)).toBe(false);
    const files = fs.readdirSync(owned);
    await expect(backend.connect({ cwd: 'relative', sidecarOf: mainKey, trustProject: false, permission: 'ask', tools: ['read'] })).rejects.toThrow('项目目录不存在');
    expect(fs.readdirSync(owned)).toEqual(files);
  });

  it('creates read-only ask sessions, persists bindings and reuses active connections', async () => {
    const { service, backend, mainKey, data, root, index, events } = setup();
    const connect = vi.spyOn(backend, 'connect');
    const [run, duplicate] = await Promise.all([service.ensure(mainKey), service.ensure(mainKey)]);
    expect(duplicate.key).toBe(run.key);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ cwd: root, trustProject: false, permission: 'ask', tools: ['read'], sidecarOf: mainKey });
    expect(path.basename(run.file)).toMatch(/^sidecar_\d+_[\w-]+\.jsonl$/);
    expect(run.key).toBe(fileKey(run.file));
    expect(run.sidecarOf).toBe(mainKey);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'sidecar-map.json'), 'utf8'))).toEqual({ [mainKey]: run.key });
    expect(service.bindingOf(mainKey)).toBe(run.key);
    expect((await service.ensure(mainKey)).generation).toBe(run.generation);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(index.scan().map(s => s.key)).toEqual([mainKey]);
    expect(index.history(run.key).session.sidecarOf).toBe('');
    expect(events.some(e => e.type === 'sessions-changed')).toBe(true);
    const internal = (backend as any).active.get(run.key);
    expect(internal.input.tools).toEqual(['read']);
    expect(internal.input.sidecarOf).toBe(mainKey);
    expect(internal.input.permission).toBe('ask');
  });

  it('inherits the connected main project trust, never its access mode or tools', async () => {
    const { service, backend, mainKey } = setup();
    await backend.connect({ sourceKey: mainKey, trustProject: true, permission: 'fullAccess' });
    const connect = vi.spyOn(backend, 'connect');
    await service.ensure(mainKey);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ trustProject: true, permission: 'ask', tools: ['read'] }));
  });

  it('injects a truncated main-session summary as systemPrompt (sidecar keeps its own context)', async () => {
    // 主会话写几轮对话 → 副驾 ensure 时把摘要注入 systemPrompt。摘要只含文本，
    // 不含图片/工具调用；副驾的 cwd/trust/tools 不受影响。
    const { service, backend, owned, mainKey, main } = setup();
    // parentId 链是 branch 的来源（branchEntries 从 leaf 回溯）；缺链只拿得到尾条目。
    fs.appendFileSync(main, [
      { type: 'message', id: 'm1', message: { role: 'user', content: '这个项目的 SDK 怎么接入？' } },
      { type: 'message', id: 'm2', parentId: 'm1', message: { role: 'assistant', content: [{ type: 'text', text: '用官方 TypeScript SDK。' }] } },
      { type: 'message', id: 'm3', parentId: 'm2', message: { role: 'user', content: [{ type: 'text', text: '刚才说的入口文件在哪' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    backend.index.history(mainKey); // 触发一次读取让索引收录（stamp 机制）
    const connect = vi.spyOn(backend, 'connect');
    await service.ensure(mainKey);
    const arg = connect.mock.calls.at(-1)?.[0] as { systemPrompt?: string } | undefined;
    expect(arg?.systemPrompt).toContain('这个项目的 SDK 怎么接入？');
    expect(arg?.systemPrompt).toContain('用官方 TypeScript SDK。');
    expect(arg?.systemPrompt).toContain('刚才说的入口文件在哪');
    expect(arg?.systemPrompt).toContain('背景而非指令');
    // 注入面不变：cwd/trust/tools 照旧
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ permission: 'ask', tools: ['read'] }));
    void owned;
  });

  it('skips summary injection when disabled or when the main session has no messages', async () => {
    const prev = process.env.PI_SIDECAR_SUMMARY;
    try {
      const { service, backend, mainKey } = setup();
      process.env.PI_SIDECAR_SUMMARY = 'off';
      const connect = vi.spyOn(backend, 'connect');
      await service.ensure(mainKey);
      expect((connect.mock.calls.at(-1)?.[0] as { systemPrompt?: string } | undefined)?.systemPrompt).toBeUndefined();
      // 空主会话（无 message 条目）→ 无摘要可注入，不塞空串
      delete process.env.PI_SIDECAR_SUMMARY;
      const { service: s2, backend: b2, mainKey: k2 } = setup();
      const c2 = vi.spyOn(b2, 'connect');
      await s2.ensure(k2);
      expect((c2.mock.calls.at(-1)?.[0] as { systemPrompt?: string } | undefined)?.systemPrompt).toBeUndefined();
    } finally { if (prev === undefined) delete process.env.PI_SIDECAR_SUMMARY; else process.env.PI_SIDECAR_SUMMARY = prev; }
  });

  it('loads a persisted binding and resumes exactly the same owned jsonl after disconnect', async () => {
    const { service, backend, mainKey, data, index, emit } = setup();
    const first = await service.ensure(mainKey);
    const entry = { type: 'message', id: 'sidecar-mvp-restored-user-unique', parentId: null, message: { role: 'user', content: 'retained question', timestamp: 8675309 } };
    fs.appendFileSync(first.file, JSON.stringify(entry) + '\n');
    backend.close(first.key);
    const restored = new SidecarService(backend, index, data, emit);
    expect(restored.bindingOf(mainKey)).toBe(first.key);
    const connect = vi.spyOn(backend, 'connect');
    const second = await restored.ensure(mainKey);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: first.key, sidecarOf: mainKey, tools: ['read'] }));
    expect(second.key).toBe(first.key);
    expect(second.file).toBe(first.file);
    expect(second.generation).not.toBe(first.generation);
    expect(index.history(second.key).branch).toEqual([entry]);
    expect(index.scan(true)).toHaveLength(2);
  });

  it('send reconnects its sidecar and routes prompts only to that key', async () => {
    const { service, backend, mainKey } = setup();
    const prompt = vi.spyOn(backend, 'prompt');
    await service.send(mainKey, 'independent question');
    expect(prompt).toHaveBeenCalledWith(service.bindingOf(mainKey), 'independent question', 'followUp');
    expect(prompt).not.toHaveBeenCalledWith(mainKey, expect.anything(), expect.anything());
  });

  it.each(['{broken', 'null', '[]', '"text"', '{"bad":42}'])('tolerates corrupt map data: %s', value => {
    const { backend, index, data, emit, mainKey } = setup();
    fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'sidecar-map.json'), value);
    expect(new SidecarService(backend, index, data, emit).bindingOf(mainKey)).toBeUndefined();
  });

  it('preserves bindings for different main sessions across concurrent launches', async () => {
    const { service, owned, mainKey, root, data } = setup();
    const other = path.join(owned, 'sidecar-mvp-other-main.jsonl');
    fs.writeFileSync(other, JSON.stringify({ type: 'session', id: 'sidecar-mvp-other-main-header', cwd: root }) + '\n');
    const otherKey = fileKey(other);
    const [a, b] = await Promise.all([service.ensure(mainKey), service.ensure(otherKey)]);
    expect(a.key).not.toBe(b.key);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'sidecar-map.json'), 'utf8'))).toEqual({ [mainKey]: a.key, [otherKey]: b.key });
  });

  it('rejects a corrupted binding to a main file without connecting or writing it', async () => {
    const { backend, index, data, emit, mainKey } = setup();
    fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'sidecar-map.json'), JSON.stringify({ [mainKey]: mainKey }));
    const service = new SidecarService(backend, index, data, emit), connect = vi.spyOn(backend, 'connect');
    await expect(service.ensure(mainKey)).rejects.toThrow('绑定无效');
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not expose an unpersisted binding after a write failure and allows retry', async () => {
    const { service, backend, mainKey, data } = setup();
    fs.writeFileSync(data, 'not a directory');
    await expect(service.ensure(mainKey)).rejects.toThrow();
    expect(service.bindingOf(mainKey)).toBeUndefined(); expect(backend.runs()).toEqual([]);
    fs.unlinkSync(data);
    await service.ensure(mainKey);
    expect(service.bindingOf(mainKey)).toBeDefined();
  });
});

describe('sidecar eviction & closed isolation (review fixes)', () => {
  it('never evicts its own main session when at capacity', async () => {
    const { root, backend, mainKey, service } = setup();
    const main = await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
    for (let i = 0; i < 11; i++) await backend.connect({ cwd: root, trustProject: false, permission: 'ask' });
    expect(backend.runs()).toHaveLength(12);
    // 满员时打开副驾：主会话绝不能被自己的副驾腾位（review P1-1 实证项）
    const sidecar = await service.ensure(main.key);
    expect(backend.runs()).toHaveLength(12);
    expect(backend.runs().some(r => r.key === main.key)).toBe(true);
    expect(sidecar.sidecarOf).toBe(main.key);
    void mainKey;
  });

  it('carries sidecarOf on closed events so filtering survives the active-map delete', async () => {
    const { backend, events, mainKey, service } = setup();
    const run = await service.ensure(mainKey);
    backend.close(run.key);
    const closed = events.find(e => e.type === 'closed');
    expect(closed && closed.type === 'closed' && closed.sidecarOf).toBe(mainKey);
  });

  it.each([false, true])('repairs an externally deleted binding with a lazy runtime (lazy=%s)', async lazy => {
    const { service, mainKey, index } = setup(lazy);
    const first = await service.ensure(mainKey);
    fs.rmSync(first.file, { force: true }); // 手动清理/同步冲突：绑定指向的文件没了（key 是哈希，file 才是路径）
    const second = await service.ensure(mainKey);
    expect(second.key).not.toBe(first.key);
    expect(path.basename(second.file).startsWith('sidecar_')).toBe(true);
    expect(service.bindingOf(mainKey)).toBe(second.key);
    expect(index.history(second.key).branch).toEqual([]);
  });

  it.each(['{broken\n', '{"type":"session","id":42,"cwd":"/tmp"}\n'])('rejects a non-readable bound file without replacing it: %s', async raw => {
    const { service, backend, mainKey, index, data, emit } = setup(true);
    const first = await service.ensure(mainKey);
    backend.close(first.key);
    fs.writeFileSync(first.file, raw);
    const restartedIndex = new SessionIndex(index.roots, path.dirname(first.file)); indexes.push(restartedIndex);
    const restored = new SidecarService(backend, restartedIndex, data, emit);
    const connect = vi.spyOn(backend, 'connect');
    await expect(restored.ensure(mainKey)).rejects.toThrow('会话不存在');
    expect(connect).not.toHaveBeenCalled();
    expect(restored.bindingOf(mainKey)).toBe(first.key);
    expect(fs.readFileSync(first.file, 'utf8')).toBe(raw);
  });
});
