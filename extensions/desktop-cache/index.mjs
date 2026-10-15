// PI Desktop prompt-cache extension
//
// 背景：pi-ai 的 anthropic-messages provider 默认已放 cache_control（system 尾块 /
// 最后 user|system 消息 / tools 末项 / 转录末条，短 TTL）。Desktop 侧仍缺两块：
//   1) 第二个断点：长会话里「静态前缀」与「易变尾部」分叉时，单断点容易整段 miss；
//      Anthropic 允许 ≤4 个显式断点，ZCode 用 system 3 段各一个 + 末尾消息一个。
//   2) 长 TTL：闲置 >5min 后短 TTL 条目过期（本会话观测约 1/3 非缓存 input 属此类），
//      `PI_CACHE_RETENTION=long` 可让模型声明 1h（模型 supportsLongCacheRetention）。
//
// 做法：在 before_provider_request（payload 已含 provider 组装结果）上补断点。
// 只动 cache_control 标记，不改任何正文；不认识的 payload 形状原样返回（fail-open）。
//
// 开关：
//   PI_DESKTOP_CACHE=off      完全禁用
//   其它值（默认）            补第二个断点
// 长 TTL 不走本扩展：PI_CACHE_RETENTION=long 是 pi 进程级 env，对所有 provider 生效，
// 而 GLM 兼容口未官方承诺 1h；由用户在设置里显式决定，默认关闭。

const MAX_BREAKPOINTS = 4; // Anthropic hard limit; provider already uses up to 4.

/** 是否需要在 payload 上打标记（无 system/messages 数组的形状不动）。 */
function isAnthropicShaped(payload) {
  return Boolean(payload) && typeof payload === 'object' && Array.isArray(payload.messages);
}

/** 统计已有断点，避免超过 Anthropic 上限（provider 默认最多放 4 个）。 */
function countBreakpoints(payload) {
  let count = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node.cache_control) count += 1;
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(payload.system);
  walk(payload.tools);
  walk(payload.messages);
  return count;
}

const isTextBlock = (block) => Boolean(block) && typeof block === 'object' && typeof block.text === 'string';

/**
 * 在「最后一条可标记消息」上补第二个断点（provider 已标记的是最后一条，这里补的是
 * 更早一个安全位置：倒数第二条 user 消息的最后一个 text 块）。会话短于两条时不动。
 * 已接近上限时不再添加。返回新 payload（不改原对象）。
 */
export function placeBreakpoints(payload, mode = 'marker') {
  if (mode === 'off' || !isAnthropicShaped(payload)) return payload;
  const messages = payload.messages;
  if (countBreakpoints(payload) >= MAX_BREAKPOINTS) return payload;
  // 从尾向前找最后一个 user 消息（provider 断点落在最后一条任意角色消息上）。
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const block = message.content[message.content.length - 1];
    if (!isTextBlock(block) || block.cache_control) return payload;
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
  pi.on('before_provider_request', (event) => {
    try { return placeBreakpoints(event.payload); } catch { /* 标记失败不影响请求 */ }
  });
}
