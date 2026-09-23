import { CONTEXT_CATEGORIES, type ContextCategory, type ContextDetails } from '../../shared/context-details';

/** Character proportions of the active RPC transcript. Never persists prompt text. */
export function summarizeContext(messages: unknown, totals: unknown): ContextDetails {
  const chars: Record<ContextCategory, number> = { messages: 0, systemTools: 0, mcpTools: 0, skills: 0, systemPrompt: 0, other: 0 };
  const sections = new Map<string, string>();
  const tools = new Map<string, Record<string, unknown>>();
  const textSize = (value: unknown): number => {
    if (typeof value === 'string') return value.length;
    if (!Array.isArray(value)) return 0;
    return value.reduce((n, block) => {
      if (!block || typeof block !== 'object' || block.type === 'image') return n;
      if (block.type === 'toolCall') return n + String(block.name ?? '').length + JSON.stringify(block.arguments ?? {}).length;
      return n + String(block.text ?? block.thinking ?? '').length;
    }, 0);
  };
  let systemObserved = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system') {
      systemObserved = true;
      chars.systemPrompt += textSize(message.content);
      for (const [name, value] of Object.entries(message.sections ?? {})) {
        if (typeof value === 'string') sections.set(name, value);
        else if (value === null) sections.delete(name);
      }
      for (const tool of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
        if (typeof tool?.name === 'string') tools.set(tool.name, tool);
      }
      for (const tool of Array.isArray(message.toolsRemoved) ? message.toolsRemoved : []) tools.delete(typeof tool === 'string' ? tool : tool?.name);
    } else if (['user', 'assistant', 'toolResult', 'bashExecution', 'compactionSummary', 'branchSummary', 'custom'].includes(message.role)) {
      chars.messages += textSize(message.content ?? message.summary ?? message.output);
    }
  }
  for (const [name, text] of sections) chars[/skills?/i.test(name) ? 'skills' : 'systemPrompt'] += text.length;
  const builtin = new Set(['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls']);
  for (const [name, tool] of tools) {
    const kind = name.startsWith('mcp_') ? 'mcpTools' : builtin.has(name) ? 'systemTools' : 'other';
    chars[kind] += JSON.stringify({name, description:tool.description, parameters:tool.parameters}).length;
  }
  const t = totals as Record<string, unknown> | undefined;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const denominator = valid(t?.input) && valid(t?.cacheRead) && valid(t?.cacheWrite) ? t.input + t.cacheRead + t.cacheWrite : 0;
  return {
    // Older RPC versions omit system messages; incomplete proportions would mislead.
    breakdown: systemObserved ? CONTEXT_CATEGORIES.map(category => ({category, chars:chars[category]})) : [],
    method: 'active-transcript-chars',
    cacheHitRate: denominator > 0 ? (t!.cacheRead as number) / denominator * 100 : null,
    fetchedAt: Date.now(),
  };
}
