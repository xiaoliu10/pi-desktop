import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SubagentPanel } from '../src/renderer/pi/SubagentPanel';
import type { ChildState, SubagentChild } from '../src/renderer/pi/subagents';

const histories = [[], [{ role: 'assistant', content: [{ type: 'text', text: 'Old completed answer' }], stopReason: 'stop' }]];
describe('subagent bottom activity follows child state, not output or parent', () => {
  for (const status of ['running', 'queued', 'completed', 'failed', 'interrupted', 'skipped', 'unknown', 'recovered'] as ChildState[]) {
    for (const [i, messages] of histories.entries()) {
      it(`${status}, ${i ? 'old output' : 'no output'}`, () => {
        for (const parentRunning of [true, false]) {
          const child: SubagentChild = { id: 'child', callId: 'call', agent: 'tester', task: 'synthetic', mode: 'single', status, messages };
          const html = renderToStaticMarkup(createElement(SubagentPanel, { children: [child], initialCall: 'call', parentRunning, onClose() {}, onStop() {} }));
          if (status === 'running' || status === 'queued') {
            expect(html).toContain('class="pi-subagents__working" role="status"');
            expect(html).toMatch(/pi-subagents__working[^]*pi-spinner/);
            expect(html).toMatch(/正在工作|Working/);
          } else expect(html).not.toContain('pi-subagents__working');
        }
      });
    }
  }
});
