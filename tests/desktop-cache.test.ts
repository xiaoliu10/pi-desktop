import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cache, { placeBreakpoints } from '../extensions/desktop-cache/index.mjs';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex } from '../src/main/pi/session-index';

// 显式缓存断点扩展：provider（pi-ai anthropic-messages）默认已在 3 处放 cache_control
// （system 尾块 / 最后 user|system 消息 / tools 末项，短 TTL）。本扩展在
// before_provider_request 补「上一请求 tip」（从尾向前第一条 user 消息的末块，
// 稳态 agent 循环下是 tool_result 块）；只动 cache_control 标记，不改正文。
// 门控：ctx.model.api 必须是 anthropic-messages；PI_CACHE_RETENTION=none 跟随关闭。

const EPHEMERAL = { type: 'ephemeral' };

function payload({ messages = [], system = undefined, tools = undefined } = {}) {
  return {
    model: 'ccr-opus',
    max_tokens: 1024,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    messages,
  };
}

const userMsg = (text, extra = {}) => ({ role: 'user', content: [{ type: 'text', text, ...extra }] });
const assistantMsg = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolResultMsg = (text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] });
const marked = (node) => Boolean(node?.cache_control);

describe('placeBreakpoints：补断点位置', () => {
  it('纯聊天：在倒数第二条 user 消息的末 text 块上补断点，不改正文与其它消息', () => {
    const before = payload({ messages: [userMsg('first'), assistantMsg('ok'), userMsg('second')] });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[0].content[0])).toBe(true); // 补在更早的 user 上
    expect(after.messages[0].content[0].cache_control).toEqual(EPHEMERAL);
    expect(after.messages[2]).toBe(before.messages[2]); // 末条（provider 断点所在）不动
    expect(after.messages[1]).toBe(before.messages[1]); // 中间 assistant 不动
    expect(after.messages[0].content[0].text).toBe('first'); // 正文不变
    expect(before.messages[0].content[0].cache_control).toBeUndefined(); // 原对象不被修改
  });
  it('稳态 agent 循环（P1-2 核心场景）：末块是 tool_result 的 user 消息可打标', () => {
    // 请求 N+1 形状：[..., u_N(tr)（上一请求 tip）, a_N(tool_use), u_{N+1}(tr)（末条，provider 已标）]
    const before = payload({ messages: [userMsg('first'), toolResultMsg('r1'), assistantMsg('call'), toolResultMsg('r2')] });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[1].content[0])).toBe(true); // 上一请求 tip 的 tool_result 块
    expect(after.messages[1].content[0].tool_use_id).toBe('t1'); // 块内容不变
    expect(after.messages[3]).toBe(before.messages[3]); // 末条不动
    expect(after.messages[2]).toBe(before.messages[2]); // 中间 assistant 不动
  });
  it('跨轮：[..., u(tr), a_final, u_new] 打在上一轮末尾的 tool_result 上', () => {
    const before = payload({ messages: [userMsg('q1'), toolResultMsg('r1'), assistantMsg('final'), userMsg('q2')] });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[1].content[0])).toBe(true);
    expect(marked(after.messages[3].content[0])).toBe(false); // 末条由 provider 负责
  });
  it('候选是 image 块时也可打标（白名单与 provider 同款）', () => {
    const imageMsg = { role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] };
    const before = payload({ messages: [imageMsg, userMsg('second')] });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[0].content[0])).toBe(true);
    expect(after.messages[0].content[0].source).toBe(before.messages[0].content[0].source);
  });
  it('候选消息 content 为字符串（非数组）时跳过该消息继续向前找', () => {
    const before = payload({ messages: [{ role: 'user', content: 'plain' }, assistantMsg('mid'), userMsg('last')] });
    const after = placeBreakpoints(before);
    expect(after.messages[0].content).toBe('plain'); // 形状不改
    expect(marked(after.messages[2].content[0])).toBe(false); // 末条仍不动
  });
  it('候选块不在白名单（如 thinking）时继续向前找下一条 user 消息', () => {
    const thinkingMsg = { role: 'user', content: [{ type: 'thinking', thinking: 'x' }] };
    const before = payload({ messages: [userMsg('first'), thinkingMsg, userMsg('last')] });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[1].content[0])).toBe(false); // thinking 不打标
    expect(marked(after.messages[0].content[0])).toBe(true); // 继续向前找到 first
  });
  it('向前超过 MAX_LOOKBACK(4) 条不可标记消息时放弃，原样返回', () => {
    // 6 条 user 消息全部末块为 thinking：候选从 length-2 起最多向前 4 步，够不到 first
    const bad = () => ({ role: 'user', content: [{ type: 'thinking', thinking: 'x' }] });
    const before = payload({ messages: [userMsg('first'), bad(), bad(), bad(), bad(), bad(), userMsg('last')] });
    expect(placeBreakpoints(before)).toBe(before);
  });
  it('少于两条消息时不动', () => {
    const before = payload({ messages: [userMsg('only')] });
    expect(placeBreakpoints(before)).toBe(before);
  });
  it('幂等：f∘f = f（重复应用不再新增断点）', () => {
    const before = payload({ messages: [userMsg('first'), assistantMsg('mid'), userMsg('last')] });
    const once = placeBreakpoints(before);
    const twice = placeBreakpoints(once);
    expect(twice).toBe(once); // 第二次原样返回（候选已标 → return payload）
  });
});

describe('placeBreakpoints：上限守卫', () => {
  it('断点已达上限（4 个）时不再添加', () => {
    const before = payload({
      system: [{ type: 'text', text: 's', cache_control: EPHEMERAL }],
      tools: [{ name: 't', cache_control: EPHEMERAL }],
      messages: [userMsg('first'), userMsg('second', { cache_control: EPHEMERAL }), userMsg('third', { cache_control: EPHEMERAL })],
    });
    expect(placeBreakpoints(before)).toBe(before);
  });
  it('已有 3 个断点时恰好补到 4（边界：不超限）', () => {
    const before = payload({
      system: [{ type: 'text', text: 's', cache_control: EPHEMERAL }],
      tools: [{ name: 't', cache_control: EPHEMERAL }],
      messages: [userMsg('first'), assistantMsg('mid'), userMsg('last', { cache_control: EPHEMERAL })],
    });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[0].content[0])).toBe(true); // 补第 4 个
    const total = [...after.system, ...after.tools, ...after.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])]
      .filter(b => marked(b)).length;
    expect(total).toBe(4); // 恰好 4，不超 Anthropic 上限
  });
  it('非 Anthropic 形状（无 messages 数组）原样返回', () => {
    const openai = { model: 'x', messages: 'not-an-array' };
    expect(placeBreakpoints(openai)).toBe(openai);
    expect(placeBreakpoints(null)).toBe(null);
    expect(placeBreakpoints(undefined)).toBe(undefined);
  });
});

describe('扩展接线与门控', () => {
  const register = () => {
    const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
    const pi = { on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) { handlers[event] = handler; } };
    cache(pi);
    return handlers;
  };
  const anthropicCtx = () => ({ model: { api: 'anthropic-messages' } });
  const openaiCtx = () => ({ model: { api: 'openai-completions' } });

  it('PI_DESKTOP_CACHE=off 时不注册任何处理器', () => {
    const handlers: Record<string, unknown> = {};
    const pi = { on(event: string, handler: unknown) { handlers[event] = handler; } };
    const previous = process.env.PI_DESKTOP_CACHE;
    process.env.PI_DESKTOP_CACHE = 'off';
    try { cache(pi); } finally { if (previous === undefined) delete process.env.PI_DESKTOP_CACHE; else process.env.PI_DESKTOP_CACHE = previous; }
    expect(Object.keys(handlers)).toHaveLength(0);
  });
  it('anthropic-messages 模型：注册并返回补好断点的 payload', () => {
    const handlers = register();
    const event = { type: 'before_provider_request', payload: payload({ messages: [userMsg('first'), userMsg('second')] }) };
    const result = handlers.before_provider_request(event, anthropicCtx()) as any;
    expect(marked(result.messages[0].content[0])).toBe(true);
  });
  it('openai-completions 模型：原样返回（undefined，不注入 cache_control）——OpenAI 兼容端点不支持该字段', () => {
    const handlers = register();
    const body = payload({ messages: [userMsg('first'), userMsg('second')] });
    const event = { type: 'before_provider_request', payload: body };
    expect(handlers.before_provider_request(event, openaiCtx())).toBeUndefined();
    expect(marked(body.messages[0].content[0])).toBe(false); // 载荷未被碰
  });
  it('ctx 缺失（旧版宿主）时不打标，fail-open', () => {
    const handlers = register();
    const body = payload({ messages: [userMsg('first'), userMsg('second')] });
    expect(handlers.before_provider_request({ type: 'before_provider_request', payload: body })).toBeUndefined();
    expect(marked(body.messages[0].content[0])).toBe(false);
  });
  it('PI_CACHE_RETENTION=none 时跟随关闭（provider 不放断点，本扩展也不放）', () => {
    const handlers = register();
    const previous = process.env.PI_CACHE_RETENTION;
    process.env.PI_CACHE_RETENTION = 'none';
    const body = payload({ messages: [userMsg('first'), userMsg('second')] });
    try {
      expect(handlers.before_provider_request({ type: 'before_provider_request', payload: body }, anthropicCtx())).toBeUndefined();
      expect(marked(body.messages[0].content[0])).toBe(false);
    } finally { if (previous === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previous; }
  });
  it('PI_CACHE_RETENTION=long 时新断点跟随 1h TTL（与 provider 末条同长，前短后长合法）', () => {
    const handlers = register();
    const previous = process.env.PI_CACHE_RETENTION;
    process.env.PI_CACHE_RETENTION = 'long';
    const body = payload({ messages: [userMsg('first'), userMsg('second')] });
    try {
      const result = handlers.before_provider_request({ type: 'before_provider_request', payload: body }, anthropicCtx()) as any;
      expect(result.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    } finally { if (previous === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previous; }
  });
  it('默认（未设 RETENTION）新断点为短 TTL', () => {
    const handlers = register();
    const previous = process.env.PI_CACHE_RETENTION;
    delete process.env.PI_CACHE_RETENTION;
    const body = payload({ messages: [userMsg('first'), userMsg('second')] });
    try {
      const result = handlers.before_provider_request({ type: 'before_provider_request', payload: body }, anthropicCtx()) as any;
      expect(result.messages[0].content[0].cache_control).toEqual(EPHEMERAL);
    } finally { if (previous !== undefined) process.env.PI_CACHE_RETENTION = previous; }
  });
  it('handler 抛错不外泄（真实逼出异常：messages getter throw）', () => {
    const handlers = register();
    const body: Record<string, unknown> = { model: 'x' };
    Object.defineProperty(body, 'messages', { enumerable: true, get() { throw new Error('boom'); } });
    const event = { type: 'before_provider_request', payload: body };
    expect(() => handlers.before_provider_request(event, anthropicCtx())).not.toThrow();
    expect(handlers.before_provider_request(event, anthropicCtx())).toBeUndefined();
  });
});

describe('backend 启动接线', () => {
  it('pi 启动参数带 desktop-cache 扩展（-e 指向 extensions/desktop-cache/index.mjs）', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cache-wire-')));
    const owned = path.join(root, 'owned');
    const file = path.join(owned, 's.jsonl');
    fs.mkdirSync(owned, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'r', cwd: root, timestamp: new Date().toISOString() }) + '\n');
    const index = new SessionIndex([root, owned], owned);
    const backend = new PiBackend({ executable: path.resolve('tests/fixtures/fake-pi.mjs'), version: '0.85.1', supported: true, agentDir: owned, sessionDirs: [], diagnostics: [] } as any, index, owned, path.resolve('extensions/desktop-policy/index.mjs'), () => undefined);
    const spawns: string[][] = [];
    backend.clientFactory = (cmd: string, args: string[]) => { spawns.push(args); throw new Error('stub: 记录参数后不真起进程'); };
    await expect(backend.connect({ cwd: root, trustProject: false, permission: 'ask' })).rejects.toThrow('stub');
    expect(spawns).toHaveLength(1);
    const extensionArgs = spawns[0].filter((arg, i) => spawns[0][i - 1] === '-e');
    expect(extensionArgs.some(p => p.endsWith(path.join('extensions', 'desktop-cache', 'index.mjs')))).toBe(true);
    expect(extensionArgs.some(p => p.endsWith(path.join('extensions', 'desktop-policy', 'index.mjs')))).toBe(true);
    index.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
