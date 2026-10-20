import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RendererHistory } from '../src/main/pi/renderer-history';
import { SessionIndex } from '../src/main/pi/session-index';
import type { PiEntry, PiHistory } from '../src/shared/pi';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })));
const image = { type: 'image', data: 'A'.repeat(200_000), mimeType: 'image/png', extension: 'kept' };
const entry = (role: string, id: string): PiEntry => ({ type: 'message', id, parentId: null,
  message: { role, content: [{ type: 'text', text: 'output' }, { ...image }], details: { nested: { ...image } } } });
const history = (entries: PiEntry[], branch = entries): PiHistory => ({
  session: { key: 'k', id: 's', path: '/s', cwd: '/p', name: 's', updatedAt: 1, size: 1, warnings: [], owned: true },
  entries, branch, leaves: ['t'], leafId: 't', syncedAt: 1,
});

describe('Desktop renderer history projection', () => {
  it('omits only toolResult image data and preserves metadata, text and details', () => {
    const raw = history([entry('toolResult', 't')]);
    const wire = new RendererHistory().project(raw);
    const content = wire.branch[0].message!.content as any[];
    expect(content[1]).toEqual({ type: 'image', mimeType: 'image/png', extension: 'kept', omittedBase64Chars: image.data.length });
    expect(content[0]).toBe((raw.branch[0].message!.content as any[])[0]);
    expect(wire.branch[0].message!.details).toBe(raw.branch[0].message!.details);
    expect((raw.branch[0].message!.content as any[])[1].data).toBe(image.data);
    expect(wire.entries).toBe(wire.branch);
    expect(wire.session).toBe(raw.session);
  });

  it('preserves user, assistant, custom image content and non-image blocks', () => {
    const raw = history(['user', 'assistant', 'custom'].map(role => entry(role, role)));
    expect(new RendererHistory().project(raw)).toBe(raw);
  });

  it('projects both distinct entries and branch without modifying the internal arrays', () => {
    const a = entry('toolResult', 'a'), b = entry('toolResult', 'b');
    const raw = history([a, b], [b]);
    const projector = new RendererHistory();
    const wire = projector.project(raw);
    expect((wire.entries[0].message!.content as any[])[1].data).toBeUndefined();
    expect((wire.branch[0].message!.content as any[])[1].data).toBeUndefined();
    expect(wire.entries[1]).toBe(wire.branch[0]);
    expect(raw.entries[1]).toBe(b);
    expect((b.message!.content as any[])[1].data).toBe(image.data);
    expect(projector.project(raw)).toBe(wire);
    const appended = history([...raw.entries, entry('user', 'c')]);
    const next = projector.project(appended);
    expect(next).not.toBe(wire);
    expect(next.entries[1]).toBe(wire.entries[1]);
  });

  it('keeps short internal history and fork entries lossless', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-history-')); roots.push(root);
    const file = path.join(root, 's.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 's', cwd: '/p' },
      entry('toolResult', 't'),
    ].map(v => JSON.stringify(v)).join('\n') + '\n');
    const index = new SessionIndex([root], root);
    const key = index.scan()[0].key;
    const raw = index.history(key);
    const projector = new RendererHistory();
    const wire = projector.project(raw);
    expect((wire.branch[0].message!.content as any[])[1].data).toBeUndefined();
    expect((index.history(key).branch[0].message!.content as any[])[1].data).toBe(image.data);
    expect((index.history(key).entries[0].message!.content as any[])[1].data).toBe(image.data);
    expect(projector.project(index.history(key))).toBe(wire);
    index.close();
  });

  it('handles a paged response with 29 large image blocks without losing rows or user images', () => {
    const rows = Array.from({ length: 500 }, (_, i) => entry(i < 29 ? 'toolResult' : 'user', String(i)));
    // Only tool results carry large data in this fixture; user attachments stay visible.
    for (const row of rows.slice(29)) row.message!.content = [{ type: 'text', text: row.id }];
    rows[499] = entry('user', '499');
    const raw = history(rows);
    raw.truncated = { total: 20_000, returned: 500 };
    const wire = new RendererHistory().project(raw);
    expect(wire.branch).toHaveLength(500);
    expect(wire.truncated).toBe(raw.truncated);
    expect((wire.branch[499].message!.content as any[])[1].data).toBe(image.data);
    expect(wire.branch.map(e => e.id)).toEqual(raw.branch.map(e => e.id));
    for (const row of wire.branch.slice(0, 29)) expect((row.message!.content as any[])[1].data).toBeUndefined();
  });

  it('tolerates malformed blocks and is idempotent', () => {
    const row = entry('toolResult', 't');
    row.message!.content = [null, 1, 'text', { type: 'image', data: 42 }, { ...image }];
    const projector = new RendererHistory();
    const wire = projector.project(history([row]));
    expect((wire.branch[0].message!.content as any[]).slice(0, 4)).toEqual((row.message!.content as any[]).slice(0, 4));
    expect(projector.project(wire)).toBe(wire);
  });
});
