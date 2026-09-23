import { beforeEach, describe, expect, it } from 'vitest';
import {
  createNavHistory,
  pushNavEntry,
  navBack,
  navForward,
  canGoBack,
  canGoForward,
  removeSessionFromNavHistory,
  NAV_HISTORY_LIMIT,
} from '../src/renderer/pi/navigation-history';
import { usePiStore } from '../src/renderer/pi/adapter';

describe('navigation-history（ZCode taskNavigationHistory 语义）', () => {
  it('push 入栈并前进 cursor；相邻重复去重', () => {
    let h = createNavHistory();
    h = pushNavEntry(h, { view: 'home' });
    h = pushNavEntry(h, { view: 'chat', key: 'a' });
    h = pushNavEntry(h, { view: 'chat', key: 'a' }); // 相邻重复
    h = pushNavEntry(h, { view: 'plugins' });
    expect(h.entries.map((e) => `${e.view}:${e.key ?? ''}`)).toEqual(['home:', 'chat:a', 'plugins:']);
    expect(h.cursor).toBe(2);
  });

  it('back/forward 只动 cursor 不动 entries', () => {
    let h = createNavHistory();
    h = pushNavEntry(h, { view: 'home' });
    h = pushNavEntry(h, { view: 'chat', key: 'a' });
    h = pushNavEntry(h, { view: 'automations' });
    expect(canGoBack(h)).toBe(true);
    const back = navBack(h);
    expect(back?.entry).toEqual({ view: 'chat', key: 'a' });
    expect(back!.history.entries).toHaveLength(3);
    const fwd = navForward(back!.history);
    expect(fwd?.entry).toEqual({ view: 'automations' });
    // 边界：到底不能后退，到顶不能前进
    let edge = createNavHistory();
    expect(navBack(edge)).toBeNull();
    edge = pushNavEntry(edge, { view: 'home' });
    expect(canGoBack(edge)).toBe(false);
    expect(canGoForward(edge)).toBe(false);
    expect(navForward(edge)).toBeNull();
  });

  it('中途回退后再 push 会截断前进分支', () => {
    let h = createNavHistory();
    for (const v of ['home', 'chat', 'plugins'] as const) h = pushNavEntry(h, v === 'chat' ? { view: 'chat', key: 'a' } : { view: v });
    h = navBack(h)!.history;
    h = pushNavEntry(h, { view: 'settings' });
    expect(h.entries.map((e) => e.view)).toEqual(['home', 'chat', 'settings']);
    expect(canGoForward(h)).toBe(false);
  });

  it('超过上限裁掉最旧条目', () => {
    let h = createNavHistory();
    for (let i = 0; i < NAV_HISTORY_LIMIT + 5; i++) h = pushNavEntry(h, { view: 'chat', key: `k${i}` });
    expect(h.entries).toHaveLength(NAV_HISTORY_LIMIT);
    expect(h.entries[0].key).toBe('k5');
    expect(h.cursor).toBe(NAV_HISTORY_LIMIT - 1);
  });

  it('会话删除移除其条目并修正 cursor；其余视图条目保留', () => {
    let h = createNavHistory();
    h = pushNavEntry(h, { view: 'home' });
    h = pushNavEntry(h, { view: 'chat', key: 'a' });
    h = pushNavEntry(h, { view: 'plugins' });
    h = pushNavEntry(h, { view: 'chat', key: 'a' });
    const next = removeSessionFromNavHistory(h, 'a');
    expect(next.entries.map((e) => `${e.view}:${e.key ?? ''}`)).toEqual(['home:', 'plugins:']);
    expect(next.cursor).toBe(1); // 原 cursor 3，前方删掉 2 条 chat:a
    // 删除不存在的会话原样返回（同引用）
    expect(removeSessionFromNavHistory(next, 'missing')).toBe(next);
    // 删空重置
    expect(removeSessionFromNavHistory(pushNavEntry(createNavHistory(), { view: 'chat', key: 'only' }), 'only')).toEqual(createNavHistory());
  });
});

describe('PiReplicaStore 导航记录器与回放', () => {
  beforeEach(() => {
    usePiStore.setState({ view: 'home', selectedKey: null, navHistory: pushNavEntry(createNavHistory(), { view: 'home' }) });
  });

  it('视图/会话切换自动入栈，相邻重复不入栈', () => {
    usePiStore.setState({ view: 'chat', selectedKey: 'k1' });
    usePiStore.setState({ view: 'chat', selectedKey: 'k1' });
    usePiStore.setState({ view: 'plugins', selectedKey: 'k1' });
    const h = usePiStore.getState().navHistory;
    expect(h.entries.map((e) => `${e.view}:${e.key ?? ''}`)).toEqual(['home:', 'chat:k1', 'plugins:']);
    expect(canGoBack(h)).toBe(true);
  });

  it('navBack/navForward 回放不产生新条目、不截断前进分支', () => {
    usePiStore.setState({ view: 'chat', selectedKey: 'k1' });
    usePiStore.setState({ view: 'plugins', selectedKey: 'k1' });
    usePiStore.getState().navBack();
    expect(usePiStore.getState().view).toBe('chat');
    expect(usePiStore.getState().selectedKey).toBe('k1');
    usePiStore.getState().navBack();
    expect(usePiStore.getState().view).toBe('home');
    // 回放后再前进，历史完整
    usePiStore.getState().navForward();
    usePiStore.getState().navForward();
    expect(usePiStore.getState().view).toBe('plugins');
    const h = usePiStore.getState().navHistory;
    expect(h.entries.map((e) => `${e.view}:${e.key ?? ''}`)).toEqual(['home:', 'chat:k1', 'plugins:']);
  });

  it('空历史 navBack/navForward 无副作用', () => {
    usePiStore.setState({ navHistory: createNavHistory() });
    usePiStore.getState().navBack();
    usePiStore.getState().navForward();
    expect(usePiStore.getState().view).toBe('home');
    expect(usePiStore.getState().navHistory.entries).toEqual([]);
  });
});
