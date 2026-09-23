import { describe, expect, it } from 'vitest';
import {
  applyMenuSelection,
  buildNavPoints,
  countDots,
  filterCommands,
  filterFiles,
  messageText,
  parseMenuState,
} from '../replica/chat/helpers';
import { demoLongConversation, demoSlashCommands, demoFiles } from './fixtures';

describe('U03 composer menu parsing', () => {
  it('opens slash menu at start, file menu after @', () => {
    expect(parseMenuState('/plan')).toEqual({ kind: 'slash', query: 'plan' });
    expect(parseMenuState('hello @src/set')).toEqual({ kind: 'file', query: 'src/set' });
  });

  it('stays closed for plain text or spaced triggers', () => {
    expect(parseMenuState('just text')).toEqual({ kind: null, query: '' });
    expect(parseMenuState('/ after space')).toEqual({ kind: null, query: '' });
    expect(parseMenuState('hello @src/ trailing')).toEqual({ kind: null, query: '' });
    expect(parseMenuState('email@example.com')).toEqual({ kind: null, query: '' });
  });

  it('filters commands by name or description', () => {
    const cmds = demoSlashCommands('en');
    expect(filterCommands(cmds, 'plan')).toHaveLength(1);
    expect(filterCommands(cmds, 'todo')).toHaveLength(1);
    expect(filterCommands(cmds, '')).toHaveLength(cmds.length);
  });

  it('filters files and replaces the trigger token on selection', () => {
    const files = demoFiles('en');
    expect(filterFiles(files, 'theme')).toEqual(['src/theme-tokens.css']);
    // file choices include the leading @, slash choices the leading /
    expect(applyMenuSelection('look at @the', '@src/theme-tokens.css')).toBe('look at @src/theme-tokens.css ');
    expect(applyMenuSelection('/pl', '/todos')).toBe('/todos ');
  });
});

describe('U03 message nav', () => {
  it('creates one point per message with stable ratios', () => {
    const msgs = demoLongConversation('en');
    const points = buildNavPoints(msgs);
    expect(points).toHaveLength(msgs.length);
    expect(points[0].ratio).toBe(0);
    expect(points[points.length - 1].ratio).toBe(1);
  });

  it('long demo conversation covers tools, diffs, errors and demo labels', () => {
    const msgs = demoLongConversation('en');
    const parts = msgs.flatMap((m) => m.parts);
    const tools = parts.filter((p) => p.kind === 'tool');
    expect(tools.length).toBeGreaterThanOrEqual(4);
    expect(parts.some((p) => p.kind === 'error')).toBe(true);
    const withDiff = tools.find((p) => p.kind === 'tool' && p.diff);
    expect(withDiff).toBeTruthy();
    expect(msgs.filter((m) => m.simulated).length).toBe(msgs.filter((m) => m.role === 'assistant').length);
    // stable ids for screenshots/tests
    expect(new Set(msgs.map((m) => m.id)).size).toBe(msgs.length);
  });

  it('flattens text for search indexing', () => {
    const msgs = demoLongConversation('zh');
    expect(messageText(msgs[0])).toContain('重新设计');
  });
});

describe('U03 diff stats', () => {
  it('counts +/- lines', () => {
    expect(countDots({ lines: [{ type: '+' }, { type: '-' }, { type: ' ' }, { type: '+' }] })).toEqual({
      additions: 2,
      deletions: 1,
    });
  });
});
