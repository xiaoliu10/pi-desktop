import { describe, expect, it } from 'vitest';
import { SIDEBAR_SESSION_LIMIT, visibleSessions } from '../src/renderer/replica/shell/helpers';
import type { SessionNavItem } from '../src/renderer/replica/contracts';

function session(id: string, updatedAt: number): SessionNavItem {
  return { id, title: `s-${id}`, updatedAt, source: 'desktop', syncedAt: undefined, canContinue: false, busy: false };
}

const many = Array.from({ length: 9 }, (_, i) => session(String(i), 1000 - i));

describe('visibleSessions', () => {
  it('shows only the most recent sessions until expanded', () => {
    const shown = visibleSessions(many, false);
    expect(shown).toHaveLength(SIDEBAR_SESSION_LIMIT);
    // list arrives newest-first; the visible slice must keep that order
    expect(shown.map((s) => s.id)).toEqual(['0', '1', '2', '3', '4']);
  });

  it('shows everything once expanded', () => {
    expect(visibleSessions(many, true)).toHaveLength(many.length);
  });

  it('is a no-op for short lists', () => {
    const few = many.slice(0, 3);
    expect(visibleSessions(few, false)).toEqual(few);
  });
});
