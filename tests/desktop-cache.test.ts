import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cache, { placeBreakpoints } from '../extensions/desktop-cache/index.mjs';
import { PiBackend } from '../src/main/pi/backend';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';

// 显式缓存断点扩展：provider（pi-ai anthropic-messages）默认已放 4 类断点
// （system 尾块 / 最后 user|system 消息 / tools 末项 / 转录末条，短 TTL）。
// 本扩展在 before_provider_request 补「更早一个 user 消息」断点，保护长会话里
// 静态前缀与易变尾部分叉；只动 cache_control 标记，不改正文，形状不认识原样返回。

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
const marked = (node) => Boolean(node?.cache_control);

describe('placeBreakpoints：补第二个断点', () => {
  it('在倒数第二个 user 消息的末 text 块上补断点，且不改正文与其它消息', () => {
    const before = payload({ messages: [userMsg('first'), assistantMsg('ok'), userMsg('second')] });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[0].content[0])).toBe(true); // 补在更早的 user 上
    expect(after.messages[0].content[0].cache_control).toEqual(EPHEMERAL);
    expect(after.messages[2]).toBe(before.messages[2]); // 末条（provider 断点所在）不动
    expect(after.messages[1]).toBe(before.messages[1]); // 中间 assistant 不动
    expect(after.messages[0].content[0].text).toBe('first'); // 正文不变
    expect(before.messages[0].content[0].cache_control).toBeUndefined(); // 原对象不被修改
  });
  it('末条消息已带断点时仍可补更早一个（两个断点共存）', () => {
    const before = payload({ messages: [userMsg('first'), userMsg('second', { cache_control: EPHEMERAL })] });
    const after = placeBreakpoints(before);
    expect(marked(after.messages[0].content[0])).toBe(true);
    expect(marked(after.messages[1].content[0])).toBe(true);
  });
  it('候选块已有断点则不重复添加（幂等）', () => {
    const before = payload({ messages: [userMsg('first', { cache_control: EPHEMERAL }), userMsg('second')] });
    const after = placeBreakpoints(before);
    const count = after.messages.filter(m => m.role === 'user' && marked(m.content[0])).length;
    expect(count).toBe(1); // 没有变成两个
  });
  it('少于两条消息时不动', () => {
    const before = payload({ messages: [userMsg('only')] });
    expect(placeBreakpoints(before)).toBe(before);
  });
  it('非 Anthropic 形状（无 messages 数组）原样返回', () => {
    const openai = { model: 'x', messages: 'not-an-array' };
    expect(placeBreakpoints(openai)).toBe(openai);
    expect(placeBreakpoints(null)).toBe(null);
    expect(placeBreakpoints(undefined)).toBe(undefined);
  });
  it('断点已达上限（4 个）时不再添加', () => {
    const before = payload({
      system: [{ type: 'text', text: 's', cache_control: EPHEMERAL }],
      tools: [{ name: 't', cache_control: EPHEMERAL }],
      messages: [userMsg('first'), userMsg('second', { cache_control: EPHEMERAL }), userMsg('third', { cache_control: EPHEMERAL })],
    });
    expect(placeBreakpoints(before)).toBe(before);
  });
  it('user 消息 content 为字符串（非数组）时跳过，不改形状', () => {
    const before = payload({ messages: [{ role: 'user', content: 'plain' }, userMsg('second')] });
    const after = placeBreakpoints(before);
    expect(after.messages[0].content).toBe('plain');
    expect(marked(after.messages[1].content[0])).toBe(false); // 没有可标记的 text 块
  });
});

describe('扩展接线', () => {
  it('PI_DESKTOP_CACHE=off 时不注册任何处理器', () => {
    const handlers: Record<string, unknown> = {};
    const pi = { on(event: string, handler: unknown) { handlers[event] = handler; } };
    const previous = process.env.PI_DESKTOP_CACHE;
    process.env.PI_DESKTOP_CACHE = 'off';
    try { cache(pi); } finally { if (previous === undefined) delete process.env.PI_DESKTOP_CACHE; else process.env.PI_DESKTOP_CACHE = previous; }
    expect(Object.keys(handlers)).toHaveLength(0);
  });
  it('默认注册 before_provider_request 且返回补好断点的 payload', () => {
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const pi = { on(event: string, handler: (event: unknown) => unknown) { handlers[event] = handler; } };
    cache(pi);
    const event = { type: 'before_provider_request', payload: payload({ messages: [userMsg('first'), userMsg('second')] }) };
    const result = handlers.before_provider_request(event) as any;
    expect(marked(result.messages[0].content[0])).toBe(true);
  });
  it('handler 抛错不外泄（扩展不破坏请求）', () => {
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const pi = { on(event: string, handler: (event: unknown) => unknown) { handlers[event] = handler; } };
    cache(pi);
    const event = { type: 'before_provider_request', payload: { messages: [{ role: 'user', content: null }] } };
    expect(() => handlers.before_provider_request(event)).not.toThrow();
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
