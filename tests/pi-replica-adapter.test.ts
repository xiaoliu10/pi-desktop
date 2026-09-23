import { describe, expect, it } from 'vitest';
import {
  buildPiSidebar,
  groupModels,
  historyToMessages,
  liveToMessages,
  parseUnifiedDiff,
  reviewDiffEntries,
  pathBase,
  resourcesToPluginRows,
  sessionTitleOf,
} from '../src/renderer/pi/adapter';
import type { PiEntry, PiResource, PiRun, PiSession } from '../src/shared/pi';

describe('P08 history → chat messages', () => {
  const branch: PiEntry[] = [
    { id: 'e1', type: 'message', message: { role: 'user', content: '修复测试' } },
    {
      id: 'e2',
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先看一下测试文件。' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.test.ts' } },
        ],
        errorMessage: undefined,
      },
    },
    { id: 'e3', type: 'message', message: { role: 'toolResult', toolName: 'read', content: 'line1\nline2', isError: false } },
    { id: 'e4', type: 'message', message: { role: 'toolResult', toolName: 'run', content: 'boom', isError: true } },
    { id: 'e5', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '修好了。' }], errorMessage: 'retry warning' } },
    { id: 'e6', type: 'compaction', summary: '…' },
    { id: 'e7', type: 'custom', customType: 'plan-state' },
  ];

  it('maps user, assistant tools, tool results and records', () => {
    const msgs = historyToMessages(branch);
    expect(msgs[0]).toMatchObject({ role: 'user', parts: [{ kind: 'text', text: '修复测试' }] });
    const assistant = msgs[1];
    expect(assistant.parts.some((p) => p.kind === 'text' && p.text.includes('测试文件'))).toBe(true);
    const call = assistant.parts.find((p) => p.kind === 'tool') as { tool: string; status: string };
    expect(call.tool).toBe('read');
    expect(call.status).toBe('done');
    const result = msgs[2].parts[0] as { kind: string; tool: string; status: string };
    expect(result).toMatchObject({ kind: 'tool', tool: 'read', status: 'done' });
    const failed = msgs[3].parts[0] as { status: string };
    expect(failed.status).toBe('error');
    const last = msgs[4];
    expect(last.parts.some((p) => p.kind === 'error' && p.message === 'retry warning')).toBe(true);
    const notices = msgs.filter((m) => m.parts.some((p) => p.kind === 'notice'));
    expect(notices).toHaveLength(2);
  });

  it('keeps entry ids stable', () => {
    expect(historyToMessages(branch).map((m) => m.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  });
});

describe('P08 live streaming map', () => {
  it('renders live assistant text and running tool progress', () => {
    const msgs = liveToMessages(
      { t1: { role: 'assistant', content: [{ type: 'text', text: '正在写代码' }] } },
      [{ toolCallId: 'x', name: 'edit', text: 'src/a.ts', status: 'running' }],
    );
    expect(msgs[0].parts[0]).toMatchObject({ kind: 'text', text: '正在写代码' });
    expect(msgs[1].parts[0]).toMatchObject({ kind: 'tool', tool: 'edit', status: 'running' });
  });
});

describe('P08 unified diff parser', () => {
  it('parses multi-file diffs with counts and created files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'a.ts', created: false, additions: 1, deletions: 1 });
    expect(files[0].lines[0]).toEqual({ type: ' ', text: 'keep', line: 1 });
    expect(files[1]).toMatchObject({ path: 'new.ts', created: true, additions: 2, deletions: 0 });
  });

  it('returns empty array for empty diffs', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('merges untracked files into review entries as created rows', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');
    const entries = reviewDiffEntries({ root: '/r', baseline: 'HEAD', diff, untracked: ['n.md'], untrackedFiles: [{ path: 'n.md', lines: 12 }, { path: 'a.ts', lines: 5 }] });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 });
    expect(entries[1]).toMatchObject({ path: 'n.md', created: true, additions: 12, deletions: 0 });
  });
});

describe('P08 resource → plugin row mapping', () => {
  const resources: PiResource[] = [
    { id: '1', name: 'plan-mode', kind: 'extensions', path: '/p', scope: 'user', status: 'discovered', detail: 'd' },
    { id: '2', name: 'cmd', kind: 'prompts', path: '/p', scope: 'project', status: 'callable', detail: 'd' },
    { id: '3', name: 'broken', kind: 'extensions', path: '/p', scope: 'user', status: 'error', detail: '损坏' },
    { id: '4', name: 'off', kind: 'skills', path: '/p', scope: 'user', status: 'disabled', detail: 'd' },
  ];
  it('maps statuses honestly', () => {
    const rows = resourcesToPluginRows(resources);
    expect(rows.map((r) => r.status)).toEqual(['updatable', 'active', 'attention', 'off']);
    expect(rows[2].error).toBe('损坏');
    expect(rows[0].badge).toBe('全局');
    expect(rows[1].badge).toBe('项目');
  });
});

describe('P08 models & sidebar', () => {
  it('groups models by provider', () => {
    const run = {
      models: [
        { id: 'gpt-5.6', name: 'GPT-5.6', provider: 'OpenAI' },
        { id: 'mini', name: 'Mini', provider: 'OpenAI' },
        { id: 'opus', name: 'Opus', provider: 'Anthropic' },
      ],
    } as unknown as PiRun;
    const groups = groupModels(run);
    expect(groups.map((g) => g.provider)).toEqual(['OpenAI', 'Anthropic']);
    expect(groups[0].models[0].id).toBe('OpenAI/gpt-5.6');
  });

  it('builds sidebar projects from session cwds with CLI/desktop source', () => {
    const sessions: PiSession[] = [
      { key: 'k1', id: '1', path: '/w/apps/.pi/s1.jsonl', cwd: '/w/apps', name: 's1', updatedAt: 10, size: 1, warnings: [], owned: false },
      { key: 'k2', id: '2', path: '/w/apps/.pi/s2.jsonl', cwd: '/w/apps', name: 's2', updatedAt: 20, size: 1, warnings: [], owned: true },
      { key: 'k3', id: '3', path: '/w/web/s3.jsonl', cwd: '/w/web', name: 's3', updatedAt: 30, size: 1, warnings: [], owned: false },
    ];
    const { temporary, projects } = buildPiSidebar(sessions, [], ['/w/apps'], {});
    expect(temporary).toEqual([]);
    expect(projects[0].id).toBe('/w/web'); // most recent first
    const apps = projects.find((p) => p.id === '/w/apps')!;
    expect(apps.name).toBe('apps');
    expect(apps.sessions.map((s) => s.id)).toEqual(['k2', 'k1']);
    const cli = apps.sessions.find((s) => s.id === 'k1')!;
    expect(cli.source).toBe('pi-cli');
    expect(cli.canContinue).toBe(true);
    expect(apps.sessions.find((s) => s.id === 'k2')!.source).toBe('desktop');
  });

  it('shows orphan desktop runs as temporary entries', () => {
    const runs = [{ key: 'run1', generation: 'g', cwd: '/w/apps', file: '', status: 'running', models: [], commands: [], pending: 0 } as unknown as PiRun];
    const { temporary } = buildPiSidebar([], runs, [], {});
    expect(temporary).toHaveLength(1);
    expect(temporary[0].busy).toBe(true);
  });

  it('pathBase extracts folder names', () => {
    expect(pathBase('/Users/jason/projects/wengine/model-benchmark')).toBe('model-benchmark');
    expect(pathBase('C:\\work\\apps')).toBe('apps');
  });

  it('sessionTitleOf prefers pi title, then Desktop rename, then session name', () => {
    const base = { titles: {}, renames: {}, sessions: [], runs: [], selectedKey: null, pendingPrompt: undefined } as unknown as Parameters<typeof sessionTitleOf>[0];
    const session = { key: 'k1', name: '修复登录接口', cwd: '/w/a', owned: true };
    const run = { key: 'k1', cwd: '/w/a' } as unknown as Parameters<typeof sessionTitleOf>[0]['runs'][number];
    // 无 setTitle 标题时回退会话名，不再显示“新桌面会话”。
    expect(sessionTitleOf({ ...base, selectedKey: 'k1', sessions: [session as never], runs: [run] })).toBe('修复登录接口');
    expect(sessionTitleOf({ ...base, selectedKey: 'k1', sessions: [session as never], runs: [run], renames: { k1: '新名字' } })).toBe('新名字');
    expect(sessionTitleOf({ ...base, selectedKey: 'k1', sessions: [session as never], runs: [run], titles: { k1: 'pi 标题' } })).toBe('pi 标题');
    expect(sessionTitleOf({ ...base, selectedKey: 'k1', runs: [run] })).toBe('新桌面会话');
  });
});
