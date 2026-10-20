import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { OutlineCache } from '../src/main/pi/outline-cache';

const header = { type: 'session', version: 3, id: 's', cwd: '/project' };
const valid = JSON.stringify(header) + '\n';
const invalid = valid.replace('session', 'foreign'); // same byte length
let root: string;
const indexes: SessionIndex[] = [];
const outlines: OutlineCache[] = [];
const makeIndex = (outline?: OutlineCache) => {
  const index = new SessionIndex([root], root, outline);
  indexes.push(index);
  return index;
};
const sessionReads = (reads: ReturnType<typeof vi.spyOn<typeof fs, 'readFileSync'>>, file: string) =>
  reads.mock.calls.filter(([target]) => target === file).length;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rejected-')));
});
afterEach(() => {
  indexes.splice(0).forEach(index => index.close());
  outlines.splice(0).forEach(outline => outline.flushNow());
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function start(index: SessionIndex, watch: boolean) {
  vi.useFakeTimers();
  const watcher = vi.spyOn(fs, 'watch').mockImplementation(() => {
    if (!watch) throw new Error('watch unavailable');
    return { close: vi.fn() } as unknown as fs.FSWatcher;
  });
  index.start(vi.fn());
  return (file: string) => {
    const listener = watcher.mock.calls[0]?.[2] as unknown as (event: string, filename: string) => void;
    listener('change', path.relative(root, file));
    vi.advanceTimersByTime(120);
  };
}

function tick(notify: (file: string) => void, file: string, watch: boolean) {
  if (watch) notify(file);
  else vi.advanceTimersByTime(31_200); // stat fallback, before the 30-check full walk
}

describe('rejected session content stamps', () => {
  it('does not re-read or JSON-parse unchanged foreign, damaged, empty or incomplete files on full scans', () => {
    const contents = [invalid, 'not-json\n', '', '{"type":"session"', '{"type":"session","id":1,"cwd":"/p"}\n'];
    const files = contents.map((content, i) => {
      const file = path.join(root, `${i}.jsonl`);
      fs.writeFileSync(file, content);
      return file;
    });
    const good = path.join(root, 'good.jsonl');
    fs.writeFileSync(good, valid);
    const index = makeIndex();
    expect(index.scan(true)).toHaveLength(1);
    const reads = vi.spyOn(fs, 'readFileSync');
    const parses = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 3; i++) expect(index.scan(true).map(s => s.path)).toEqual([good]);
    expect(reads).not.toHaveBeenCalled();
    expect(parses).not.toHaveBeenCalled();
    fs.appendFileSync(good, '{"type":"message","id":"u","message":{"role":"user","content":"hello"}}\n');
    expect(index.history(fileKey(good)).session.name).toBe('hello');
    expect(files.every(file => sessionReads(reads, file) === 0)).toBe(true);
  });

  it.each(['{"type":"session"', JSON.stringify(header), ''])('recognizes a completed header after rejecting %j', partial => {
    const file = path.join(root, 's.jsonl');
    fs.writeFileSync(file, partial);
    const index = makeIndex();
    expect(index.scan()).toEqual([]);
    fs.appendFileSync(file, valid.slice(partial.length));
    expect(index.scan()[0]?.id).toBe('s');
  });

  it.each(['ino', 'size', 'mtimeMs', 'ctimeMs'] as const)('invalidates rejection when only %s changes', field => {
    const file = path.join(root, 's.jsonl');
    fs.writeFileSync(file, invalid);
    const stamp = fs.statSync(file);
    const actual = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike) => target === file ? stamp : actual(target)) as typeof fs.statSync);
    const index = makeIndex();
    expect(index.scan()).toEqual([]);
    fs.writeFileSync(file, valid);
    stamp[field] += 1;
    expect(index.scan()[0]?.id).toBe('s');
  });

  it('rechecks same-size rewrites even with preserved mtime (ctime changes)', () => {
    const file = path.join(root, 's.jsonl');
    fs.writeFileSync(file, invalid);
    const index = makeIndex();
    expect(index.scan()).toEqual([]);
    const before = fs.statSync(file);
    fs.writeFileSync(file, valid);
    fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).size).toBe(before.size);
    expect(index.scan()[0]?.id).toBe('s');
  });

  it('rechecks inode replacement even if size and timestamps match', () => {
    const file = path.join(root, 's.jsonl'), replacement = path.join(root, 'replace.tmp');
    fs.writeFileSync(file, invalid);
    const index = makeIndex();
    index.scan();
    const before = fs.statSync(file);
    fs.writeFileSync(replacement, valid);
    fs.renameSync(replacement, file);
    const actual = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike) => {
      const stat = actual(target);
      if (target === file) { stat.mtimeMs = before.mtimeMs; stat.ctimeMs = before.ctimeMs; }
      return stat;
    }) as typeof fs.statSync);
    expect(index.scan()[0]?.id).toBe('s');
  });

  it('cleans rejection records on rename, deletion and recreation', () => {
    const file = path.join(root, 's.jsonl'), renamed = path.join(root, 'renamed.jsonl');
    fs.writeFileSync(file, invalid);
    const index = makeIndex();
    index.scan();
    fs.renameSync(file, renamed);
    index.scan();
    const state = index as unknown as { rejected: Map<string, string> };
    expect([...state.rejected.keys()]).toEqual([renamed]);
    fs.unlinkSync(renamed);
    index.scan();
    expect(state.rejected.size).toBe(0);
    // Recreate the exact rejected stamp: only deletion cleanup can make this readable.
    fs.writeFileSync(file, invalid);
    index.scan();
    const before = fs.statSync(file);
    fs.unlinkSync(file);
    index.scan();
    fs.writeFileSync(file, valid);
    const actual = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike) => target === file ? before : actual(target)) as typeof fs.statSync);
    expect(index.scan()[0]?.id).toBe('s');
  });

  it.each([true, false])('watch=%s skips rejected content but detects rewrites, rename, truncation and recreation', watch => {
    const file = path.join(root, 's.jsonl'), renamed = path.join(root, 'renamed.jsonl');
    fs.writeFileSync(file, invalid);
    const index = makeIndex();
    const notify = start(index, watch);
    const reads = vi.spyOn(fs, 'readFileSync');
    const parses = vi.spyOn(JSON, 'parse');
    tick(notify, file, watch);
    tick(notify, file, watch);
    expect(sessionReads(reads, file)).toBe(0);
    expect(parses).not.toHaveBeenCalled();
    fs.writeFileSync(file, valid);
    tick(notify, file, watch);
    expect(index.sessionsView()[0]?.id).toBe('s');
    fs.writeFileSync(file, invalid + ' '.repeat(1024));
    tick(notify, file, watch);
    expect(index.sessionsView()).toEqual([]);
    fs.writeFileSync(file, valid); // truncate rejected content
    tick(notify, file, watch);
    expect(index.sessionsView()).toHaveLength(1);
    fs.writeFileSync(file, invalid);
    tick(notify, file, watch);
    fs.renameSync(file, renamed);
    tick(notify, file, watch);
    tick(notify, renamed, watch);
    fs.writeFileSync(renamed, valid);
    tick(notify, renamed, watch);
    expect(index.sessionsView().map(s => s.path)).toEqual([renamed]);
    fs.unlinkSync(renamed);
    tick(notify, renamed, watch);
    expect(index.sessionsView()).toEqual([]);
    fs.writeFileSync(renamed, valid);
    tick(notify, renamed, watch);
    expect(index.sessionsView()).toHaveLength(1);
    fs.writeFileSync(renamed, JSON.stringify(header)); // complete JSON, missing newline
    tick(notify, renamed, watch);
    expect(index.sessionsView()).toEqual([]);
    fs.appendFileSync(renamed, '\n');
    tick(notify, renamed, watch);
    expect(index.sessionsView()[0]?.id).toBe('s');
    fs.writeFileSync(renamed, invalid);
    tick(notify, renamed, watch);
    fs.unlinkSync(renamed);
    tick(notify, renamed, watch);
    const state = index as unknown as { rejected: Map<string, string> };
    expect(state.rejected.size).toBe(0);
  });

  it.each([true, false])('watch=%s retries transient read failures without changing the stamp', watch => {
    const file = path.join(root, 's.jsonl');
    fs.writeFileSync(file, valid);
    const index = makeIndex();
    const read = fs.readFileSync.bind(fs);
    let fail = true;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (target === file && fail) throw Object.assign(new Error('temporary read failure'), { code: 'EIO' });
      return Reflect.apply(read, fs, [target, ...args]);
    }) as typeof fs.readFileSync);
    const notify = start(index, watch);
    expect(index.sessionsView()).toEqual([]);
    fail = false;
    tick(notify, file, watch);
    expect(index.sessionsView()[0]?.id).toBe('s');
    // Also retry a changed rejected file whose first re-read failed.
    fs.writeFileSync(file, invalid);
    tick(notify, file, watch);
    expect(index.sessionsView()).toEqual([]);
    fs.writeFileSync(file, valid);
    fail = true;
    tick(notify, file, watch);
    expect(index.sessionsView()).toEqual([]);
    fail = false;
    tick(notify, file, watch);
    expect(index.sessionsView()[0]?.id).toBe('s');
  });

  it('settles a dirty replaced file once without repeatedly parsing rejected content', () => {
    const file = path.join(root, 's.jsonl'), replacement = path.join(root, 'replacement.tmp');
    fs.writeFileSync(file, valid + ' '.repeat(300 * 1024));
    vi.useFakeTimers();
    const index = makeIndex();
    index.scan();
    fs.writeFileSync(replacement, invalid + ' '.repeat(310 * 1024));
    fs.renameSync(replacement, file);
    index.scan();
    // Isolate settle from the existing poll timer, which re-arms settle every check.
    const state = index as unknown as { dirty: Map<string, unknown>; scheduleSettle: () => void };
    expect(state.dirty.size).toBe(1);
    state.scheduleSettle();
    vi.advanceTimersByTime(1500);
    expect(index.sessionsView()).toEqual([]);
    expect(state.dirty.size).toBe(0);
    const reads = vi.spyOn(fs, 'readFileSync');
    state.scheduleSettle();
    vi.advanceTimersByTime(1500);
    index.scan();
    expect(sessionReads(reads, file)).toBe(0);
  });

  it('invalidates dirty history, branch/plan memos and outline without resurrecting stale turns', () => {
    vi.useFakeTimers();
    const file = path.join(root, 's.jsonl');
    const outline = new OutlineCache(path.join(root, 'outlines.json'));
    outlines.push(outline);
    const entries = [header,
      { type: 'message', id: 'u', message: { role: 'user', content: 'x'.repeat(300 * 1024) } },
      { type: 'message', id: 'p', parentId: 'u', message: { role: 'toolResult', toolName: 'desktop_update_plan', content: [{ type: 'text', text: '{"plan":[{"step":"old","status":"pending"}]}' }] } },
    ];
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const index = makeIndex(outline), key = index.scan()[0].key;
    expect(index.history(key, 'u').branch).toHaveLength(1); // branch memo
    expect(index.history(key).plan).toHaveLength(1); // plan memo
    expect(index.sessionOutline(key).total).toBe(1);
    const outlineStat = fs.statSync(file);
    expect(outline.get(key, outlineStat, 'p')).toHaveLength(1);
    const replacement = path.join(root, 'replacement.tmp');
    fs.writeFileSync(replacement, invalid + ' '.repeat(310 * 1024));
    fs.renameSync(replacement, file);
    index.scan(); // large replaced file is dirty until history/settle requests parsing
    expect(index.sessionOutline(key)).toEqual({ turns: [], total: 0 });
    expect(index.sessionsView()).toEqual([]);
    expect(outline.get(key, outlineStat, 'p')).toBeUndefined();
    const state = index as unknown as { dirty: Map<string, unknown>; branchMemo: Map<string, unknown>; planMemos: Map<string, unknown> };
    expect(state.dirty.has(key)).toBe(false);
    expect(state.branchMemo.has(key)).toBe(false);
    expect(state.planMemos.has(key)).toBe(false);
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(() => index.history(key)).toThrow();
    index.scan();
    expect(sessionReads(reads, file)).toBe(0);
    fs.writeFileSync(file, valid);
    expect(index.scan()).toHaveLength(1);
    expect(index.history(key).plan).toBeUndefined();
  });
});
