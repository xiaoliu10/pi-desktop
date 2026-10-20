import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { saveContinuations } from '../src/main/pi/session-continuations';

const roots: string[] = [];
const backends: PiBackend[] = [];
afterEach(() => {
  backends.splice(0).forEach(b => b.dispose());
  roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true }));
});
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-target-'))); roots.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned);
  const write = (file: string, parentSession?: string) => {
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: path.basename(file), cwd: root, ...(parentSession ? { parentSession } : {}) }) + '\n');
    return file;
  };
  const source = write(path.join(root, 'cli.jsonl'));
  const index = new SessionIndex([root], owned);
  const backend = new PiBackend({ supported: true, executable: path.resolve('tests/fixtures/fake-pi.mjs'), version: '0.85.1', agentDir: root, sessionDirs: [root], diagnostics: [] }, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), () => undefined, root);
  backends.push(backend);
  return { root, owned, source, write, index, backend };
}

describe('read-only history target resolution', () => {
  it('returns the external key when no Desktop copy exists, with no writes or runtime spawn', () => {
    const { source, index, backend } = setup(); index.scan();
    const factory = vi.fn(); backend.clientFactory = factory;
    const before = fs.readFileSync(source);
    expect(backend.resolveSessionKey(fileKey(source))).toBe(fileKey(source));
    expect(factory).not.toHaveBeenCalled(); expect(backend.runs()).toEqual([]);
    expect(fs.readFileSync(source)).toEqual(before);
  });

  it('chooses the newest existing Desktop copy and matches connect without sending a prompt', async () => {
    const { source, owned, write, index, backend } = setup();
    const old = write(path.join(owned, 'old.jsonl'), source);
    const latest = write(path.join(owned, 'latest.jsonl'), source);
    fs.utimesSync(old, 1, 1); fs.utimesSync(latest, 2, 2); index.scan();
    const before = fs.readFileSync(source);
    const key = backend.resolveSessionKey(fileKey(source));
    expect(key).toBe(fileKey(latest));
    expect(backend.runs()).toEqual([]);
    expect((await backend.connect({ sourceKey: fileKey(source), permission: 'ask', trustProject: false })).key).toBe(key);
    expect(fs.readFileSync(source)).toEqual(before);
  });

  it('ignores auxiliary conversation files with the same parent', () => {
    const { source, owned, write, index, backend } = setup();
    const copy = write(path.join(owned, 'copy.jsonl'), source);
    const sidecar = write(path.join(owned, 'sidecar_new.jsonl'), source);
    fs.utimesSync(copy, 1, 1); fs.utimesSync(sidecar, 2, 2); index.scan();
    expect(backend.resolveSessionKey(fileKey(source))).toBe(fileKey(copy));
  });

  it('follows an existing copy continuation without confusing it with another source conversation', () => {
    const { source, owned, write, index, backend, root } = setup();
    const copy = write(path.join(owned, 'copy.jsonl'), source);
    const tip = write(path.join(owned, 'continued.jsonl'), copy);
    const unrelated = write(path.join(owned, 'unrelated.jsonl'), '/somewhere/else.jsonl');
    fs.utimesSync(unrelated, 99, 99);
    saveContinuations(root, { [copy]: tip }); index.scan();
    expect(backend.resolveSessionKey(fileKey(source))).toBe(fileKey(tip));
    expect(backend.resolveSessionKey(fileKey(copy))).toBe(fileKey(tip));
  });

  it('keeps an owned conversation unchanged without creating another copy', () => {
    const { owned, write, index, backend } = setup();
    const file = write(path.join(owned, 'owned.jsonl')); index.scan();
    expect(backend.resolveSessionKey(fileKey(file))).toBe(fileKey(file));
    expect(fs.readdirSync(owned)).toEqual(['owned.jsonl']);
  });

  it('rejects unknown keys instead of selecting the newest conversation in the project', () => {
    const { index, backend } = setup(); index.scan();
    expect(() => backend.resolveSessionKey('unknown')).toThrow('会话不存在');
  });
});
