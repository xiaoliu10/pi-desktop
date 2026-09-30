import { describe, expect, it } from 'vitest';
import { historyToMessages, liveToMessages } from '../src/renderer/pi/adapter';
import { executionTurns } from '../src/renderer/replica/chat/execution';
import { modelErrorPart } from '../src/renderer/pi/model-error';
import type { ChatMessage } from '../src/renderer/replica/contracts';

const failure = (id: string): ChatMessage => ({ id, role: 'assistant', modelOutcome: 'error', parts: [modelErrorPart({ errorMessage: 'fetch failed' }, id)!] });
const user = (id: string): ChatMessage => ({ id, role: 'user', parts: [] });
const success = (id: string): ChatMessage => ({ id, role: 'assistant', modelOutcome: 'success', parts: [{ kind: 'text', id: `${id}-text`, text: '恢复成功' }] });
const errors = (messages: ChatMessage[]) => executionTurns(messages).flatMap(t => t.answer).filter(p => p.kind === 'error');

describe('recovered model errors are presentation-only hidden', () => {
  it('hides preceding failed attempts after a successful response, without deleting original diagnostics', () => {
    const messages = [user('recover-u'), failure('recover-e1'), failure('recover-e2'), success('recover-ok')];
    const before = JSON.stringify(messages);
    expect(errors(messages)).toEqual([]);
    expect(JSON.stringify(messages)).toBe(before);
  });
  it('keeps a new terminal failure after a previous recovery visible', () => {
    expect(errors([user('again-u'), failure('again-e1'), success('again-ok'), failure('again-e2')]).map(p => p.id)).toEqual(['again-e2']);
  });
  it('does not treat empty starts, partial output, tools or cancellation as confirmed recovery', () => {
    for (const outcome of ['streaming', 'aborted', 'error', undefined] as const) {
      const tail = { ...success(`partial-${outcome}`), modelOutcome: outcome };
      expect(errors([user(`partial-u-${outcome}`), failure(`partial-e-${outcome}`), tail])).toHaveLength(1);
    }
    expect(errors([user('tools-u'), failure('tools-e'), { id: 'tools-result', role: 'assistant', parts: [{ id: 't', kind: 'tool', tool: 'bash', status: 'done', phase: 'result', summary: 'done' }] }])).toHaveLength(1);
  });
  it('never hides a previous user turn or non-model error', () => {
    const general: ChatMessage = { id: 'general-e', role: 'assistant', parts: [{ id: 'general', kind: 'error', message: 'extension failed' }] };
    expect(errors([user('boundary-u1'), failure('boundary-e'), user('boundary-u2'), general, success('boundary-ok')]).map(p => p.id)).toEqual(['boundary-e', 'general']);
  });
  it('maps success identically for persisted and live responses, including empty success', () => {
    for (const stopReason of ['stop', 'length', 'toolUse']) {
      const message = { role: 'assistant', content: [], stopReason };
      expect(historyToMessages([{ id: `outcome-${stopReason}`, type: 'message', message }])[0].modelOutcome).toBe('success');
      expect(liveToMessages({ id: message }, [])[0].modelOutcome).toBe('success');
    }
  });
  it('invalidates the turn cache when a middle member changes while endpoints stay unchanged', () => {
    const head = user('middle-u'), first = failure('middle-e'), tail: ChatMessage = { id: 'middle-tail', role: 'assistant', parts: [{ id: 'n', kind: 'notice', text: 'audit' }] };
    const pending: ChatMessage = { id: 'middle', role: 'assistant', modelOutcome: 'streaming', parts: [] };
    expect(errors([head, first, pending, tail])).toHaveLength(1);
    expect(errors([head, first, { ...pending, modelOutcome: 'success' }, tail])).toHaveLength(0);
  });
});
