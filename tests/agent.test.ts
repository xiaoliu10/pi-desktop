import { describe, expect, it, vi } from 'vitest';
import { buildChatMessages, systemPrompt } from '../src/main/agent/prompt';
import { PermissionService } from '../src/main/agent/permissions';
import { TOOLS } from '../src/main/agent/tools';
import type { TranscriptEvent } from '../src/shared/types';

// The store imports electron's safeStorage through secrets.ts; tests never
// touch it, but keep a mock so the import does not explode under vitest.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b,
  },
}));

describe('buildChatMessages', () => {
  it('groups tool calls and results into assistant + tool turns', () => {
    const events: TranscriptEvent[] = [
      { t: 'user', id: 'u1', ts: 1, text: 'fix the bug' },
      { t: 'tool_call', id: 'c1', ts: 2, name: 'read_file', args: { path: 'a.ts' } },
      { t: 'tool_result', id: 'r1', callId: 'c1', ts: 3, ok: true, output: 'const x = 1;' },
      { t: 'tool_call', id: 'c2', ts: 4, name: 'edit_file', args: { path: 'a.ts' } },
      { t: 'tool_result', id: 'r2', callId: 'c2', ts: 5, ok: false, error: 'old_string not found' },
      { t: 'assistant', id: 'a1', ts: 6, text: 'Tried and failed.' },
    ];
    const msgs = buildChatMessages('sys', events);
    expect(msgs).toHaveLength(6);
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'fix the bug' });
    const assistant = msgs[2] as { role: string; toolCalls: Array<{ id: string }>; content: string };
    expect(assistant.role).toBe('assistant');
    expect(assistant.toolCalls.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(msgs[3]).toMatchObject({ role: 'tool', result: { toolCallId: 'c1', ok: true } });
    expect(msgs[4]).toMatchObject({ role: 'tool', result: { toolCallId: 'c2', ok: false } });
    expect(msgs[5]).toEqual({ role: 'assistant', content: 'Tried and failed.' });
  });

  it('keeps a resultless call as an explicit failure for the model', () => {
    const events: TranscriptEvent[] = [
      { t: 'user', id: 'u1', ts: 1, text: 'hi' },
      { t: 'tool_call', id: 'c1', ts: 2, name: 'run_command', args: { command: 'ls' } },
    ];
    const msgs = buildChatMessages('sys', events);
    const toolMsg = msgs[msgs.length - 1] as { role: string; result: { content: string } };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.result.content).toBe('(no result recorded)');
  });
});

describe('systemPrompt', () => {
  it('plan mode blocks edits until approved', () => {
    const locked = systemPrompt({
      mode: 'plan',
      planApproved: false,
      projectName: 'p',
      projectPath: '/p',
      platform: 'darwin',
    });
    expect(locked).toContain('Do NOT edit files');
    const approved = systemPrompt({
      mode: 'plan',
      planApproved: true,
      projectName: 'p',
      projectPath: '/p',
      platform: 'darwin',
    });
    expect(approved).toContain('approved');
  });
});

describe('PermissionService', () => {
  const read = TOOLS.find((t) => t.name === 'read_file')!;
  const write = TOOLS.find((t) => t.name === 'edit_file')!;
  const exec = TOOLS.find((t) => t.name === 'run_command')!;

  it('always allows read tools', async () => {
    const svc = new PermissionService({ ask: vi.fn(), cancelAll: vi.fn() });
    const result = await svc.check({ sessionId: 's', tool: read, summary: '', mode: 'ask', planBlocks: false });
    expect(result.allowed).toBe(true);
  });

  it('asks and honors allow_session grants for later calls', async () => {
    const ask = vi.fn().mockResolvedValue('allow_session');
    const svc = new PermissionService({ ask, cancelAll: vi.fn() });
    const first = await svc.check({ sessionId: 's', tool: write, summary: '', mode: 'ask', planBlocks: false });
    expect(first.allowed).toBe(true);
    const second = await svc.check({ sessionId: 's', tool: write, summary: '', mode: 'ask', planBlocks: false });
    expect(second.allowed).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('autoEdit mode allows writes but still asks for exec', async () => {
    const ask = vi.fn().mockResolvedValue('deny');
    const svc = new PermissionService({ ask, cancelAll: vi.fn() });
    const writeResult = await svc.check({ sessionId: 's', tool: write, summary: '', mode: 'autoEdit', planBlocks: false });
    expect(writeResult.allowed).toBe(true);
    const execResult = await svc.check({ sessionId: 's', tool: exec, summary: '', mode: 'autoEdit', planBlocks: false });
    expect(execResult.allowed).toBe(false);
  });

  it('blocks privileged tools in unapproved plan mode', async () => {
    const ask = vi.fn();
    const svc = new PermissionService({ ask, cancelAll: vi.fn() });
    const result = await svc.check({ sessionId: 's', tool: write, summary: '', mode: 'ask', planBlocks: true });
    expect(result.allowed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('tools', () => {
  it('confine write paths to the project root', async () => {
    const writeFile = TOOLS.find((t) => t.name === 'write_file')!;
    await expect(
      writeFile.run({ path: '../evil.ts', content: 'x' }, { root: '/tmp/root', log: () => {} }),
    ).rejects.toThrow(/escapes project root/);
  });

  it('edit_file requires a unique match', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pidt-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\nx\n');
    const edit = TOOLS.find((t) => t.name === 'edit_file')!;
    const bad = await edit.run({ path: 'a.txt', old_string: 'x', new_string: 'y' }, { root, log: () => {} });
    expect(bad.ok).toBe(false);
    const good = await edit.run(
      { path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true },
      { root, log: () => {} },
    );
    expect(good.ok).toBe(true);
    expect(good.diff?.hunks.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('y\ny\n');
  });
});
