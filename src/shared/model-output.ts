/** Empty stream starts and error events do not prove that model output resumed. */
export function hasModelOutput(event: Record<string, unknown>): boolean {
  if (event.type !== 'message_update') return false;
  const delta = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
  if (delta?.type === 'error') return false;
  if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(delta?.type ?? '')
    && typeof delta?.delta === 'string' && delta.delta.length > 0) return true;
  const message = event.message as { role?: string; content?: unknown } | undefined;
  if (message?.role !== 'assistant') return false;
  if (typeof message.content === 'string') return message.content.length > 0;
  return Array.isArray(message.content) && message.content.some(block => block && (
    (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    || (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0)
    || block.type === 'toolCall'
  ));
}
