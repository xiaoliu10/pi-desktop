// PI Desktop prompt-cache extension
//
// 背景：pi-ai 的 anthropic-messages provider 默认已在 3 处放 cache_control（短 TTL）：
//   system 尾块（OAuth 时 system 2 处）、最后一条 user|system 消息、tools 末项（后者
//   受 supportsCacheControlOnTools 门控）。Desktop 侧补一处读点：agent 循环里每次
//   请求在「上一请求的 tip」（从尾向前第一条 user 消息的末块，稳态下多为
//   tool_result 块）也打断点——它命中的正是上一请求刚写入的缓存条目。
//
// 门控（任一不满足则原样返回，fail-open）：
//   - ctx.model.api === 'anthropic-messages'：before_provider_request 对所有 provider
//     都会触发，而 OpenAI 兼容端点不支持 cache_control（pi-ai 自己只对
//     cacheControlFormat === 'anthropic' 放标）；给严格校验端点注入未知字段可能 400。
//   - PI_CACHE_RETENTION !== 'none'：用户显式关缓存时 provider 不放断点，本扩展跟随。
//   - PI_DESKTOP_CACHE=off：注册期完全禁用。
// 断点数达 Anthropic 上限(4)不再加；只动 cache_control 标记，不改任何正文。

const MAX_BREAKPOINTS = 4; // Anthropic hard limit; provider itself may use up to 4.
// 与 provider 同款可标记块白名单（anthropic-messages.js 末条打标允许的类型）。
const MARKABLE_BLOCKS = new Set(['text', 'image', 'tool_result']);

/** 是否需要在 payload 上打标记（无 messages 数组的形状不动）。 */
function isAnthropicShaped(payload) {
  return Boolean(payload) && typeof payload === 'object' && Array.isArray(payload.messages);
}

/**
 * 统计已有断点，达到 MAX_BREAKPOINTS 即提前停（MB 级载荷避免全量遍历）。
 * 提前退出时返回值可能小于真实数，但调用方只判 >= MAX。
 */
function countBreakpoints(payload) {
  const state = { count: 0 };
  const walk = (node) => {
    if (state.count >= MAX_BREAKPOINTS || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (state.count >= MAX_BREAKPOINTS) return;
        walk(item);
      }
      return;
    }
    if (node.cache_control) state.count += 1;
    for (const value of Object.values(node)) {
      if (state.count >= MAX_BREAKPOINTS) return;
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(payload.system);
  walk(payload.tools);
  walk(payload.messages);
  return state.count;
}

/**
 * 在「从尾向前第一条 user 消息」的末块上补断点（该位置即上一请求的 tip，
 * 稳态 agent 循环下是 tool_result 块——上一请求 provider 打过写断点的位置）。
 * 候选块不在白名单（text/image/tool_result）时继续向前找；已有断点则不重标。
 * 会话短于两条、断点已达上限时不动。返回新 payload（不改原对象）。
 */
export function placeBreakpoints(payload) {
  if (!isAnthropicShaped(payload)) return payload;
  const messages = payload.messages;
  if (countBreakpoints(payload) >= MAX_BREAKPOINTS) return payload;
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const block = message.content[message.content.length - 1];
    if (!block || typeof block !== 'object' || !MARKABLE_BLOCKS.has(block.type)) continue;
    if (block.cache_control) return payload; // 已有断点不重标（f∘f = f）
    const messages_ = messages.slice();
    const content = message.content.slice();
    content[content.length - 1] = { ...block, cache_control: { type: 'ephemeral' } };
    messages_[index] = { ...message, content };
    return { ...payload, messages: messages_ };
  }
  return payload;
}

export default function (pi) {
  if ((process.env.PI_DESKTOP_CACHE || '').trim() === 'off') return;
  pi.on('before_provider_request', (event, ctx) => {
    try {
      // 只对 Anthropic 载荷打标：ctx.model.api 是 pi-ai 选 builder 的同一口径，
      // OpenAI 兼容载荷（同样有 messages 数组）不支持 cache_control。
      if (!ctx || !ctx.model || ctx.model.api !== 'anthropic-messages') return undefined;
      // 与 pi-ai getProviderEnvValue 同源（无 per-provider 前缀）：用户显式关缓存时跟随。
      if (process.env.PI_CACHE_RETENTION === 'none') return undefined;
      return placeBreakpoints(event.payload);
    } catch {
      return undefined; // 标记失败不影响请求
    }
  });
}
