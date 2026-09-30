import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetryStatus } from '../src/renderer/replica/chat/RetryStatus';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { replicaLabels } from '../src/renderer/replica/i18n';
import { historyToMessages } from '../src/renderer/pi/adapter';
import { nextModelRetryState, retryPresentation } from '../src/renderer/pi/model-retry';
import type { PiRetryGroup } from '../src/shared/pi';
import type { ChatMessage } from '../src/renderer/replica/contracts';

const group = (phase: PiRetryGroup['phase'], n = 2): PiRetryGroup => ({ group: n, maxGroups: 10, phase });
const inner = { attempt: 1, max: 3, phase: 'requesting' as const, error: 'fetch failed' };
const status = (g?: PiRetryGroup, retry = undefined as typeof inner | undefined, stopping = false) => renderToStaticMarkup(createElement(RetryStatus, { group: g, retry, zh: true, stopping, onStop: () => {} }));
const user = (id: string): ChatMessage => ({ id, role: 'user', parts: [] });
const failure = (id: string): ChatMessage => ({ id, role: 'assistant', modelOutcome: 'error', parts: [{ kind: 'error', source: 'model', id: `${id}-err`, message: 'fetch failed', details: 'original interrupted details' }] });
const messages = [user('groups-u'), failure('groups-f')];
const chat = (g: PiRetryGroup, input = messages, retry = undefined as typeof inner | undefined) => renderToStaticMarkup(createElement(ChatView, { messages: input, retryGroup: g, retrying: retry, running: g.phase === 'running', queued: 0, demo: false, labels: replicaLabels('zh').chat, onJumpToMessage: () => {} }));

afterEach(() => vi.useRealTimers());
describe('Desktop group presentation (host-owned)', () => {
  it('keeps ordinary first-group runs/completions uncluttered, but distinguishes internal retries', () => {
    expect(status(group('running', 1))).toBe('');
    expect(status(group('completed', 1))).toBe('');
    const html = status(group('running', 2), inner);
    expect(html).toContain('第 2/10 组');
    expect(html).toContain('CLI 内部重试');
    expect(html).toContain('第 1/3 次');
    expect(status(group('running', 1), inner)).toContain('第 1/10 组');
  });
  it('uses the host absolute deadline and never starts a new countdown after expiration', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const waiting = { ...group('waiting', 1), nextRetryAt: 6000, delayMs: 20000 };
    expect(status(waiting, inner)).toContain('5 秒后开始下一组');
    expect(status(waiting, inner)).not.toContain('CLI 内部重试');
    vi.setSystemTime(8000);
    expect(status(waiting)).toContain('等待下一组开始');
    expect(waiting).toEqual({ group: 1, maxGroups: 10, phase: 'waiting', nextRetryAt: 6000, delayMs: 20000 });
  });
  it.each([
    ['running', '等待模型响应', true], ['waiting', '等待下一组开始', true],
    ['exhausted', '重试组已耗尽', false], ['failed', '任务失败', false],
  ] as const)('renders %s and offers cancellation only for active work', (phase, text, cancel) => {
    const html = status(group(phase, phase === 'exhausted' ? 10 : 2));
    expect(html).toContain(text);
    expect(html.includes('取消任务')).toBe(cancel);
    if (phase === 'exhausted') expect(html).toContain('第 10/10 组');
    expect(retryPresentation(group(phase), inner).recovering).toBe(cancel);
  });
  it('retires the banner once the task settles: completed/cancelled leave no retry chrome', () => {
    // 用户反馈：任务已完成但横幅残留「Desktop 重试 · 第 N 组」被读成仍在重试。
    for (const phase of ['completed', 'cancelled'] as const) {
      expect(status(group(phase, 2))).toBe('');
      expect(retryPresentation(group(phase, 2), inner).visible).toBe(false);
      expect(retryPresentation(group(phase, 2), inner).recovering).toBe(false);
      expect(chat(group(phase, 2))).not.toContain('pi-chat__retry');
    }
  });
  it('keeps stop pending disabled without changing the host budget', () => {
    const g = Object.freeze(group('waiting'));
    expect(status(g, undefined, true)).toContain('disabled=""');
    expect(status(g, undefined, true)).toContain('正在取消');
    expect(g.phase).toBe('waiting');
    expect(retryPresentation(g, inner, true).recovering).toBe(false);
  });
  it('shows terminal host failures with redacted expandable details even in group 1', () => {
    const html = status({ ...group('failed', 1), error: 'Continuation failed\nAuthorization: Bearer TOPSECRET' });
    expect(html).toContain('Continuation failed');
    expect(html).toContain('查看错误详情');
    expect(html).not.toContain('TOPSECRET');
  });
  it('hides model failures through every active group boundary, including inner retry end', () => {
    const saved = JSON.stringify(messages);
    for (const g of [group('running', 1), group('waiting', 1), group('running', 2), group('waiting', 9), group('running', 10)]) {
      expect(chat(g)).not.toContain('pi-error-card');
      const ended = nextModelRetryState(inner, { type: 'auto_retry_end', success: false }, 0);
      expect(ended).toBeNull();
      expect(retryPresentation(g, ended).recovering).toBe(true);
    }
    expect(JSON.stringify(messages)).toBe(saved);
  });
  it.each(['failed', 'exhausted', 'cancelled'] as const)('restores saved diagnostic cards on %s despite stale inner state', phase => {
    const html = chat(group(phase, 10), messages, inner);
    expect(html).toContain('original interrupted details');
    expect(html).toContain('pi-error-card');
  });
  it('preserves success hiding, previous-turn errors and non-model/tool failures', () => {
    const success: ChatMessage = { id: 'groups-ok', role: 'assistant', modelOutcome: 'success', parts: [{ kind: 'text', id: 'groups-ok-text', text: 'recovered' }] };
    expect(chat(group('completed'), [...messages, success])).not.toContain('pi-error-card');
    const withOthers: ChatMessage[] = [user('groups-old-u'), failure('groups-old-f'), ...messages, { id: 'groups-tool', role: 'assistant', parts: [{ kind: 'tool', id: 'groups-tool-p', tool: 'bash', status: 'error', summary: 'tool still failed' }, { kind: 'error', id: 'groups-ext', message: 'extension still failed' }] }];
    const html = chat(group('waiting'), withOthers);
    expect(html).toContain('original interrupted details');
    expect(html).toContain('tool still failed');
    expect(html).toContain('extension still failed');
  });
  it('hides continuation context and display:false custom messages without hiding visible extension records', () => {
    const history = historyToMessages([
      { type: 'custom_message', id: 'groups-hidden-cont', customType: 'desktop-retry-continuation', display: false, content: 'continue internally' },
      { type: 'custom_message', id: 'groups-hidden-other', customType: 'private', display: false },
      { type: 'custom_message', id: 'groups-visible', customType: 'visible', display: true },
    ]);
    expect(history.map(m => m.id)).toEqual(['groups-visible']);
  });
});
