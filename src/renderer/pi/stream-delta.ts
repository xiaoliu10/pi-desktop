/**
 * pi RPC message_update 的增量拼装。
 *
 * pi ≥0.87 的 RPC message_update 只带 assistantMessageEvent（toJsonEvent 把 partial
 * 快照剥掉了）：{type: start|text_*|thinking_*|toolcall_*|done|error, contentIndex,
 * delta|content|toolCall}。不拼装的话渲染层拿不到任何流式文本，只能等 message_end
 * 落盘——CLI 逐 token 直写终端而 GUI 干等整条消息，正是「CLI 快 GUI 慢」的主因。
 */

export type StreamBlock = Record<string, unknown>;

/** 就地更新 blocks（当前流式中的助手消息 content），返回流是否已结束（done/error）。 */
export function applyAssistantStreamDelta(blocks: StreamBlock[], delta: Record<string, unknown>): boolean {
  const type = String(delta.type ?? '');
  const index = Math.max(0, Number(delta.contentIndex ?? 0));
  const ensure = (init: Record<string, unknown>): Record<string, unknown> => {
    while (blocks.length <= index) blocks.push({});
    const cur = blocks[index];
    if (!cur || typeof cur !== 'object' || cur.type === undefined) blocks[index] = { ...init };
    return blocks[index];
  };
  switch (type) {
    case 'start':
      blocks.length = 0;
      break;
    case 'text_start':
      ensure({ type: 'text', text: '' });
      break;
    case 'text_delta': {
      const b = ensure({ type: 'text', text: '' });
      b.text = String(b.text ?? '') + String(delta.delta ?? '');
      break;
    }
    case 'text_end': {
      const b = ensure({ type: 'text', text: '' });
      b.text = String(delta.content ?? b.text ?? '');
      break;
    }
    case 'thinking_start':
      ensure({ type: 'thinking', thinking: '' });
      break;
    case 'thinking_delta': {
      const b = ensure({ type: 'thinking', thinking: '' });
      b.thinking = String(b.thinking ?? '') + String(delta.delta ?? '');
      break;
    }
    case 'thinking_end': {
      const b = ensure({ type: 'thinking', thinking: '' });
      b.thinking = String(delta.content ?? b.thinking ?? '');
      break;
    }
    // toolcall_start 的 id/name 在 RPC 里被剥掉（随 partial 丢弃），先占位；
    // 参数以 toolcall_delta 的 JSON 片段累积，toolcall_end 的 toolCall 权威替换。
    case 'toolcall_start':
      ensure({ type: 'toolCall', name: 'tool', arguments: {} });
      break;
    case 'toolcall_delta': {
      const b = ensure({ type: 'toolCall', name: 'tool', arguments: {} });
      b._argsRaw = String(b._argsRaw ?? '') + String(delta.delta ?? '');
      break;
    }
    case 'toolcall_end': {
      const tc = delta.toolCall as Record<string, unknown> | undefined;
      if (tc) blocks[index] = { ...tc };
      break;
    }
    default:
      break;
  }
  return type === 'done' || type === 'error';
}
