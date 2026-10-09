import { describe, expect, it, vi } from 'vitest';
import type { ContextItem } from '../src/shared/composer';
import { loadWorkspacePromptHistory, recordWorkspacePrompt, workspacePromptHistory } from '../src/renderer/replica/workspace-prompt-history';

const image: ContextItem = { id: 'history-image', name: 'shot.png', path: '/shot.png', kind: 'image', text: '', image: { type: 'image', mimeType: 'image/png', data: 'large-payload' } };

describe('complete workspace prompt history', () => {
  it('keeps complete images when storage quota fails and another workspace is selected', async () => {
    const setItem = vi.fn(() => { throw new Error('quota'); });
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem } });
    const entry = { text: '', items: [image] };
    expect(recordWorkspacePrompt('/rich-history-a', entry)).toEqual([entry]);
    recordWorkspacePrompt('/rich-history-b', 'other project');
    expect(await loadWorkspacePromptHistory('/rich-history-a')).toEqual([entry]);
    expect(workspacePromptHistory('/rich-history-b')[0].text).toBe('other project');
    expect(setItem).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('deduplicates complete entries but retains same-text different attachments', () => {
    recordWorkspacePrompt('/rich-history-dedup', { text: 'look', items: [image] });
    recordWorkspacePrompt('/rich-history-dedup', { text: 'look', items: [image] });
    recordWorkspacePrompt('/rich-history-dedup', { text: 'look', items: [] });
    expect(workspacePromptHistory('/rich-history-dedup')).toHaveLength(2);
  });
});
