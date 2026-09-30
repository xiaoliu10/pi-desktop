import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { coalesceErrors, retryErrorIds } from '../src/renderer/replica/chat/error-groups';
import { executionTurns } from '../src/renderer/replica/chat/execution';
import { ChatView } from '../src/renderer/replica/chat/ChatView';
import { RetryStatus } from '../src/renderer/replica/chat/RetryStatus';
import { modelErrorPart } from '../src/renderer/pi/model-error';
import type { ChatMessage, ChatViewProps, ErrorPart, MessagePart } from '../src/renderer/replica/contracts';

const error = (id: string, message = 'fetch failed', provider = 'test'): ErrorPart => modelErrorPart({
  role: 'assistant', stopReason: 'error', errorMessage: message, provider, model: 'model', api: 'test',
}, id, Number(id.replace(/\D/g, '') || 0))!;
const failures = [error('e1'), error('e2'), error('e3'), error('e4')];
const messages: ChatMessage[] = [
  { id: 'u', role: 'user', parts: [{ id: 'u-text', kind: 'text', text: '检查网络' }] },
  ...failures.map(part => ({ id: part.id, role: 'assistant' as const, parts: [part] })),
];
const base: ChatViewProps = { messages, running: false, queued: 0, demo: false, onJumpToMessage: () => {}, labels: { you: '你', working: '工作中' } as ChatViewProps['labels'] };

describe('repeat model error presentation', () => {
  it('merges adjacent identical failures with stable identity and all diagnostics, without mutating input', () => {
    const before = JSON.stringify(failures);
    const parts = coalesceErrors(failures) as ErrorPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0].id).toBe('e1');
    expect(parts[0].occurrences?.map(item => item.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(parts[0].occurrences?.map(item => item.details)).toEqual(failures.map(item => item.details));
    expect(JSON.stringify(failures)).toBe(before);
    expect(coalesceErrors([parts[0], failures[3]])).toEqual(parts);
  });
  it('keeps different errors/providers and intervening successful output separate', () => {
    const text: MessagePart = { id: 'text', kind: 'text', text: '恢复了' };
    const parts = [error('e1'), error('e2', '429 rate limited'), error('e3', 'fetch failed', 'other'), text, error('e4')];
    expect(coalesceErrors(parts)).toEqual(parts);
    expect(coalesceErrors([error('e1'), { ...text, text: '' }, error('e2')])).toHaveLength(1);
  });
  it('groups runtime diagnostic variations while keeping the specific causes in details', () => {
    const grouped = coalesceErrors([
      error('e1', 'fetch failed\n[Desktop network diagnostics]\nECONNRESET'),
      error('e2', 'fetch failed\n[Desktop network diagnostics]\nETIMEDOUT'),
    ]) as ErrorPart[];
    expect(grouped).toHaveLength(1);
    expect(grouped[0].occurrences?.[0].details).toContain('ECONNRESET');
    expect(grouped[0].occurrences?.[1].details).toContain('ETIMEDOUT');
  });
  it('groups historical and live turns but never crosses a user boundary or changes message ids', () => {
    const turns = executionTurns([...messages, { id: 'u2', role: 'user', parts: [] }, { id: 'e5', role: 'assistant', parts: [error('e5')] }]);
    expect(turns[1].answer).toHaveLength(1);
    expect(turns[1].messageIds).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(turns[3].answer).toEqual([error('e5')]);
    expect(turns[3].id).not.toBe(turns[1].id);
  });
  it('renders one compact card with the total failure count and collapsed copyable details', () => {
    const html = renderToStaticMarkup(createElement(ChatView, base));
    expect(html.match(/class="pi-error pi-error-card"/g)).toHaveLength(1);
    expect(html).toContain('相同错误 4 次');
    expect(html).toContain('第 4/4 次错误');
    expect(html).toContain('复制错误详情');
    expect(html).not.toMatch(/<details[^>]*\sopen=/);
    expect(html).not.toContain('正在重试请求');
  });
  it('shows only one status during retry and restores the grouped card on exhaustion', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, retrying: { attempt: 3, max: 3, error: 'fetch failed', phase: 'requesting' } }));
    expect(html.match(/class="pi-chat__retry"/g)).toHaveLength(1);
    expect(html).not.toContain('class="pi-error pi-error-card"');
    expect(html).toContain('正在重试请求（第 3/3 次）');
    expect(html).not.toContain('class="pi-chat__working"');
    expect(renderToStaticMarkup(createElement(ChatView, base))).toContain('相同错误 4 次');
  });
  it('hides all model failures in the active retry turn, including different error types', () => {
    const mixed = [error('e1', 'fetch failed'), error('e2', '429 rate limited')];
    expect(retryErrorIds(mixed, '429 rate limited')).toEqual(new Set(['e2']));
    expect(retryErrorIds(mixed, 'fetch failed')).toEqual(new Set());
    expect(retryErrorIds(mixed, undefined)).toEqual(new Set());
    expect(retryErrorIds([...mixed, error('e3', '429 rate limited\n[Desktop network diagnostics]\nETIMEDOUT')], '429 rate limited')).toEqual(new Set(['e2', 'e3']));
    const html = renderToStaticMarkup(createElement(ChatView, {
      ...base, running: true, retrying: { attempt: 2, max: 3, error: '429 rate limited', phase: 'requesting' },
      messages: [messages[0], { id: 'e1', role: 'assistant' as const, parts: [error('e1')] }, { id: 'e2', role: 'assistant' as const, parts: [error('e2', '429 rate limited')] }],
    }));
    expect(html).not.toContain('class="pi-error pi-error-card"');
    expect(html).not.toContain('fetch failed');
    expect(html).not.toContain('429 rate limited');
    expect(html).toContain('正在重试请求（第 2/3 次）');
  });
  it('does not suppress failures from previous turns during a later retry', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { ...base, running: true, retrying: { attempt: 1, max: 3, error: 'fetch failed' }, messages: [...messages, { id: 'u2', role: 'user', parts: [] }, { id: 'e5', role: 'assistant', parts: [error('e5')] }] }));
    expect(html.match(/class="pi-error pi-error-card"/g)).toHaveLength(1);
    expect(html).toContain('相同错误 4 次');
  });
  it('uses backoff countdown, request and streaming phases without faking a retry after completion', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const render = (retry: Parameters<typeof RetryStatus>[0]['retry'], zh = true) => renderToStaticMarkup(createElement(RetryStatus, { retry, zh }));
      expect(render({ attempt: 2, max: 3, retryAt: 5000, phase: 'waiting' })).toContain('4 秒后重试');
      expect(render({ attempt: 2, max: 3, retryAt: 0 })).toContain('等待模型响应');
      expect(render({ attempt: 2, max: 3, phase: 'streaming' })).toContain('已恢复输出');
      expect(render({ attempt: 2, max: 0 }, false)).toContain('Retrying request (attempt 2)');
      expect(render({ attempt: 2, max: 3, error: 'Authorization: Bearer SUPER_SECRET' })).not.toContain('SUPER_SECRET');
    } finally { vi.restoreAllMocks(); }
  });
});
