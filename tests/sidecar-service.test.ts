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
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sidecar-mvp-')); roots.push(root);
  const owned = path.join(root, 'desktop'), data = path.join(root, 'data'); fs.mkdirSync(owned);
  const main = path.join(owned, 'sidecar-mvp-main.jsonl');
  fs.writeFileSync(main, JSON.stringify({ type: 'session', version: 3, id: 'sidecar-mvp-main-header', cwd: root }) + '\n');
  const index = new SessionIndex([owned], owned); indexes.push(index);
  const events: PiEvent[] = [];
  const emit = (e: PiEvent) => events.push(structuredClone(e));
  const backend = new PiBackend({ executable: path.resolve('tests/fixtures/fake-pi.mjs'), supported: true, version: '0.85.1', agentDir: root, sessionDirs: [owned], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), emit, data);
  backends.push(backend);
  return { root, owned, data, index, events, backend, mainKey: fileKey(main), service: new SidecarService(backend, index, data, emit), emit };
}

describe('retained sidecar service', () => {
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

  it('repairs a binding whose sidecar file was deleted externally', async () => {
    const { service, mainKey } = setup();
    const first = await service.ensure(mainKey);
    fs.rmSync(first.file, { force: true }); // 手动清理/同步冲突：绑定指向的文件没了（key 是哈希，file 才是路径）
    const second = await service.ensure(mainKey);
    expect(second.key).not.toBe(first.key);
    expect(path.basename(second.file).startsWith('sidecar_')).toBe(true);
    expect(service.bindingOf(mainKey)).toBe(second.key);
  });
});
