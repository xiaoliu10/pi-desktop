import { describe, expect, it } from 'vitest';
import { transcriptErrorMessage } from '../src/renderer/pi/subagent-transcript-error';

describe('child transcript errors', () => {
  it('distinguishes lookup, history, request and safety failures', () => {
    const codes = ['bad-args', 'no-history', 'no-snapshot', 'outside-sessions-root', 'read-failed'];
    for (const zh of [true, false]) {
      const values = codes.map(code => transcriptErrorMessage(code, zh));
      expect(new Set(values).size).toBe(codes.length);
    }
    expect(transcriptErrorMessage('outside-sessions-root', true)).toContain('安全校验');
    expect(transcriptErrorMessage('no-history', true)).toContain('父会话');
  });
  it('does not expose arbitrary errors or absolute paths', () => {
    expect(transcriptErrorMessage('/private/secret/file', true)).not.toContain('/private');
    expect(transcriptErrorMessage(undefined, false)).toContain('request failed');
  });
});
