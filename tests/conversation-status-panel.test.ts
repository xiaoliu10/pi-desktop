import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationStatusPanel } from '../src/renderer/pi/ConversationStatusPanel';
import type { SubagentChild } from '../src/renderer/pi/subagents';
import type { ChatMessage } from '../src/renderer/replica/contracts';

// 面板 useState 初始化读 localStorage/window.innerWidth，node 环境补最小桩。
(globalThis as Record<string, unknown>).window = { innerWidth: 1280 };
(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };

const shellTool = (status: 'running' | 'done'): ChatMessage => ({ id: 'm', role: 'assistant', parts: [{ kind: 'tool', id: 't', callId: 'c', phase: 'call', tool: 'bash', summary: 'ls', argumentsText: '', status }] });
const child = (over: Partial<SubagentChild>): SubagentChild => ({ id: 'x', callId: 'c1', agent: 'explorer', task: '查找相关源码', mode: 'single', status: 'running', messages: [], ...over });

describe('状态面板终端/子代理区（ZCode 智能体/终端区同位复刻）', () => {
  const base = { cwd: '/mock', messages: [] as ChatMessage[], running: false, onReview: () => {}, onRequest: () => {} };

  it('同级标题独立使用主题主文字和 600 字重，不将强调样式应用到计数、状态或普通行', () => {
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, {
      ...base, onOpenTerminal: () => {}, subagents: [child({})], onOpenSubagent: () => {},
      planAvailable: true, planTitle: '示例计划内容', onOpenPlan: () => {},
      stats: { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 } },
    }));
    const headings = [...html.matchAll(/<span class="pi-status-heading">([^<]+)<\/span>/g)].map(match => match[1]);
    expect(headings).toEqual(['任务状态', '终端', '子代理', '会话统计', '计划', '进程']);
    expect(html.match(/class="pi-status-heading"/g)).toHaveLength(6);
    expect(html).toContain('<span class="pi-status-terminal-meta">空闲</span>');
    expect(html).toContain('<b>1 运行 · 0 已结束</b>');
    expect(html).toContain('<b>120 tokens</b>');
    expect(html).toContain('<span>查找相关源码</span><em>运行中</em>');
    expect(html).toContain('<span>示例计划内容</span><em>右侧展示</em>');
    const css = readFileSync(new URL('../src/renderer/pi/conversation-status.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.pi-status-card \.pi-status-heading\s*\{\s*font-weight:\s*600;\s*color:\s*var\(--pi-text\)\s*\}/);
  });

  it('收起态渲染 ZCode 式胶囊（图标+标题，点击展开），不渲染卡片内容', () => {
    const store = { 'pi-status-collapsed': 'true' };
    const prev = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: () => undefined };
    try {
      const html = renderToStaticMarkup(createElement(ConversationStatusPanel, { ...base, stats: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } }));
      expect(html).toContain('pi-status-pill');
      expect(html).toContain('M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7'); // expand-diagonal
      expect(html).toContain('任务状态');
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain('展开状态面板');
      // 胶囊态不渲染卡片内容与 header
      for (const text of ['会话统计', '进程', 'pi-status-card', '状态面板菜单', '收起状态面板']) expect(html).not.toContain(text);
    } finally { (globalThis as Record<string, unknown>).localStorage = prev; }
  });

  it('展开态 header 提供收起按钮（collapse-diagonal），收起后回到胶囊', () => {
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, base));
    expect(html).toContain('M10 14H3m7 0v7m0-7-7 7M14 10h7m-7 0V3m0 7 7-7'); // collapse-diagonal
    expect(html).toContain('收起状态面板');
    expect(html).not.toContain('pi-status-pill');
  });

  it('事件链路：胶囊与收起按钮共用 toggle（写同一 localStorage 键），渲染→收起→展开全链单点持久化', () => {
    const source = new URL('../src/renderer/pi/ConversationStatusPanel.tsx', import.meta.url).pathname;
    const code = readFileSync(source, 'utf8');
    // 胶囊 onClick={toggle}：点击写 'false' 并展开（真实事件路径的源码级接线断言）
    expect(code).toContain('className="pi-status-pill" onClick={toggle}');
    // 收起按钮与标题按钮同样走 toggle（单点持久化，无第二份 localStorage 写入实现）
    expect(code).toContain('aria-label="收起状态面板" onClick={toggle}');
    expect(code.match(/pi-status-collapsed/g)).toHaveLength(2); // 初始化读取 + toggle 写入，单点持久化
    // 折叠/展开交换时焦点转移到接班控件（收起→胶囊，展开→标题按钮）
    expect(code).toContain("(collapsed?pill:titleButton).current?.focus()");
  });

  it('终端行显示运行中命令数并提供打开入口', () => {
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, { ...base, messages: [shellTool('running'), shellTool('running'), shellTool('done')], onOpenTerminal: () => {} }));
    expect(html).toContain('>终端</span>');
    expect(html).toContain('2 个命令运行中');
  });

  it('无子代理不渲染区块；有则逐条列出、统计运行数并标注点击查看', () => {
    const bare = renderToStaticMarkup(createElement(ConversationStatusPanel, base));
    expect(bare).not.toContain('子代理');
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, {
      ...base,
      subagents: [child({}), child({ id: 'y', callId: 'c2', status: 'completed', task: '跑全量测试' }), child({ id: 'z', callId: 'c3', status: 'failed', task: '修复构建' })],
      onOpenSubagent: () => {},
    }));
    expect(html).toContain('子代理');
    expect(html).toContain('1 运行 · 2 已结束');
    for (const text of ['查找相关源码', '跑全量测试', '修复构建', '运行中', '失败', 'pi-status-agent is-running', '点击查看执行情况']) expect(html).toContain(text);
  });

  const boardMarkup = (subagents: SubagentChild[]) => renderToStaticMarkup(createElement(ConversationStatusPanel, {
    ...base, subagents, onOpenSubagent() {}, onDismissSubagent() {}, onDismissFinishedSubagents() {},
  }));
  const displayedCalls = (html: string) => [...html.matchAll(/data-call-id="([^"]+)"/g)].map(match => match[1]);

  it('stably displays running, queued, then every ended status without mutating source children', () => {
    const statuses: SubagentChild['status'][] = ['failed', 'queued', 'completed', 'running', 'unknown', 'queued', 'interrupted', 'running', 'recovered', 'skipped', 'completed'];
    const children = statuses.map((status, index) => child({ id: `id-${index}`, callId: `call-${index}`, status, tokens: 100 - index }));
    const before = structuredClone(children);
    for (const item of children) Object.freeze(item);
    Object.freeze(children);
    const html = boardMarkup(children);
    expect(displayedCalls(html)).toEqual(['call-3', 'call-7', 'call-1', 'call-5', 'call-0', 'call-2', 'call-4', 'call-6', 'call-8', 'call-9', 'call-10']);
    expect(children).toEqual(before);
    expect(html).toContain('4 运行 · 7 已结束');
    expect(html.match(/class="pi-status-agent-remove"/g)).toHaveLength(7);
    expect(html).toContain('清空已结束的子代理记录');
  });

  it('recomputes category order on status transitions, but not on progress changes', () => {
    const children = [child({ id: 'a', callId: 'a', status: 'completed' }), child({ id: 'b', callId: 'b', status: 'queued' }), child({ id: 'c', callId: 'c' }), child({ id: 'd', callId: 'd' })];
    expect(displayedCalls(boardMarkup(children))).toEqual(['c', 'd', 'b', 'a']);
    children[3].tokens = 100000;
    children[2].messages = [{ role: 'assistant', content: 'progress' }];
    expect(displayedCalls(boardMarkup(children))).toEqual(['c', 'd', 'b', 'a']);
    children[2].status = 'completed';
    children[1].status = 'running';
    const html = boardMarkup(children);
    expect(displayedCalls(html)).toEqual(['b', 'd', 'a', 'c']);
    expect(html).toContain('2 运行 · 2 已结束');
    expect(html.match(/class="pi-status-agent-remove"/g)).toHaveLength(2);
    expect(children.map(item => item.callId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps shared-call live protection after rows move apart in the visible order', () => {
    const html = boardMarkup([
      child({ id: 'chain:ended', callId: 'chain', status: 'completed', task: 'protected ended sibling' }),
      child({ id: 'done', callId: 'done', status: 'failed', task: 'removable' }),
      child({ id: 'chain:live', callId: 'chain', status: 'running' }),
      child({ id: 'queue:ended', callId: 'queue', status: 'skipped' }),
      child({ id: 'queue:live', callId: 'queue', status: 'queued' }),
    ]);
    expect(displayedCalls(html)).toEqual(['chain', 'queue', 'chain', 'done', 'queue']);
    expect(html).toContain('2 运行 · 3 已结束');
    expect(html.match(/class="pi-status-agent-remove"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="从列表移除：removable"');
  });

  it('removes the floating subagent pill while keeping board and chat navigation wired to details', () => {
    const app = readFileSync(new URL('../src/renderer/pi/PiReplicaApp.tsx', import.meta.url), 'utf8');
    const board = readFileSync(new URL('../src/renderer/pi/ConversationStatusPanel.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/pi/subagents.css', import.meta.url), 'utf8');
    for (const removed of ['pi-subagents-entry', 'pi-subagents-badge', 'subagentSeen', 'setSubagentSeen', 'subagentUnseen']) {
      expect(app).not.toContain(removed);
      expect(css).not.toContain(removed);
    }
    expect(app).not.toContain('子代理 ·');
    expect(app).toMatch(/<ConversationStatusPanel\b[^\n]*subagents=\{subagents\} onOpenSubagent=\{callId=>setSubagentPanel\(\{callId\}\)\}/);
    expect(board).toContain('onClick={()=>onOpenSubagent(child.callId)}');
    expect(app).toContain('<SubagentNavigation.Provider value={callId=>{setSubagentPanel({callId});usePiStore.setState({workbenchOpen:false});}}>');
    expect(app).toMatch(/<SubagentPanel\b[^\n]*initialCall=\{subagentPanel.callId\}[^\n]*onStop=\{s.stop\}/);

    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, {
      ...base, subagents: [child({})], onOpenSubagent: () => {},
    }));
    expect(html).toContain('pi-status-agent is-running');
    expect(html).toContain('点击查看执行情况');
    expect(html).not.toContain('pi-subagents-entry');
  });

  it('计划区：有计划时展示标题行（点击右侧展示），无计划不渲染；进程头不再重复查看入口', () => {
    const bare = renderToStaticMarkup(createElement(ConversationStatusPanel, base));
    expect(bare).not.toContain('>计划</span>');
    const html = renderToStaticMarkup(createElement(ConversationStatusPanel, { ...base, planAvailable: true, planTitle: '参考 PI-Desktop 实现新项目', onOpenPlan: () => {} }));
    expect(html).toContain('>计划</span>');
    expect(html).toContain('参考 PI-Desktop 实现新项目');
    expect(html).toContain('右侧展示');
    expect(html).toContain('查看计划');
    // 进程头不再带查看计划按钮（入口已移到「计划」区，避免重复）；title 属性里的词不算
    expect(html.match(/>查看计划</g)).toHaveLength(1);
  });
});
