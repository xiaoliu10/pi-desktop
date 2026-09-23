import { describe, expect, it } from 'vitest';
import { conversationMessages, historyToMessages } from '../src/renderer/pi/adapter';

describe('live rendering after queue consumption', () => {
  const branch = [
    { id: 'u1', type: 'message', timestamp: 1000, message: { role: 'user', content: '继续迁移' } },
    { id: 'a1', type: 'message', timestamp: 2000, message: { role: 'assistant', content: [{ type: 'text', text: '我先看下。' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] } },
    { id: 'a2', type: 'message', timestamp: 3000, message: { role: 'assistant', errorMessage: 'Request timed out.', content: [] } },
    { id: 'u2', type: 'message', timestamp: 4000, message: { role: 'user', content: '排队的提问' } },
  ];
  it('shows live thinking from the new turn after a queued message was consumed', () => {
    const live = { '5000': { role: 'assistant', timestamp: 5000, content: [{ type: 'thinking', thinking: '排队后我继续思考…' }] } };
    const msgs = conversationMessages(branch as any, live, []);
    const texts = JSON.stringify(msgs);
    expect(texts).toContain('排队后我继续思考');
  });
  it('shows the timed-out assistant turn as an error line', () => {
    const msgs = conversationMessages(branch as any, {}, []);
    expect(JSON.stringify(msgs)).toContain('Request timed out.');
  });
});
