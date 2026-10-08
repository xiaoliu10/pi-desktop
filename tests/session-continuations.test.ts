import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyContinuations, recordContinuation, resolveContinuation } from '../src/main/pi/session-continuations';
import { canonical } from '../src/main/pi/session-index';

const dirs: string[] = [];
const mkfile = (name: string, body = 'x'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface S { path: string; name: string; parentSession?: string }
const s = (path: string, name: string, parentSession?: string): S => ({ path, name, parentSession });
const keyOf = (x: S) => x.path;

describe('recordContinuation', () => {
  it('记录映射且链式压缩（多级 fork 不需要逐级跳转）', () => {
    let map = recordContinuation({}, '/a.jsonl', '/b.jsonl');
    expect(map).toEqual({ '/a.jsonl': '/b.jsonl' });
    map = recordContinuation(map, '/b.jsonl', '/c.jsonl');
    // A 应直接指向 C（压缩），B→C 新增
    expect(map['/a.jsonl']).toBe('/c.jsonl');
    expect(map['/b.jsonl']).toBe('/c.jsonl');
  });
  it('同路径自映射为空操作', () => {
    expect(recordContinuation({}, '/a.jsonl', '/a.jsonl')).toEqual({});
  });
});

describe('resolveContinuation', () => {
  it('沿链走到尾，缺文件或无映射时原地停', () => {
    const a = mkfile('a.jsonl'), b = mkfile('b.jsonl'), c = mkfile('c.jsonl');
    const map = { [canonical(a)]: canonical(b), [canonical(b)]: canonical(c) };
    expect(resolveContinuation(map, a)).toBe(canonical(c));
    expect(resolveContinuation(map, b)).toBe(canonical(c));
    expect(resolveContinuation(map, c)).toBe(canonical(c));
    const gone = join(tmpdir(), 'deleted-nonexistent.jsonl');
    expect(resolveContinuation({ [canonical(a)]: gone }, a)).toBe(canonical(a)); // 链尾文件不存在 → 退化原路径
  });
});

describe('applyContinuations', () => {
  it('隐藏被延续的旧快照；延续条目顶层化并继承链头名字；用户 rename 优先', () => {
    const a = mkfile('a.jsonl'), b = mkfile('b.jsonl'), other = mkfile('other.jsonl');
    const list = [s(canonical(a), 'github 项目的readme'), s(canonical(b), '未命名 pi 会话', canonical(a)), s(canonical(other), '另一条', undefined)];
    const visible = applyContinuations(list, { [canonical(a)]: canonical(b) }, {}, keyOf, '未命名 pi 会话');
    expect(visible.map(x => x.name)).toEqual(['github 项目的readme', '另一条']);
    const fork = visible.find(x => x.path === canonical(b))!;
    expect(fork.parentSession).toBeUndefined(); // 顶层化：不被渲染层 parentSession 过滤误伤
  });
  it('用户显式 rename（按 key）优先于链头名字', () => {
    const a = mkfile('a2.jsonl'), b = mkfile('b2.jsonl');
    const list = [s(canonical(a), '原名'), s(canonical(b), '未命名 pi 会话', canonical(a))];
    const visible = applyContinuations(list, { [canonical(a)]: canonical(b) }, { [canonical(b)]: '我改过的名' }, keyOf, '未命名 pi 会话');
    expect(visible[0].name).toBe('我改过的名');
  });

  it('多级 fork：A→B→C 只显示 C（继承 A 名），中间 B 隐藏', () => {
    const a = mkfile('a3.jsonl'), b = mkfile('b3.jsonl'), c = mkfile('c3.jsonl');
    const list = [s(canonical(a), '链头名'), s(canonical(b), '中', canonical(a)), s(canonical(c), '未命名 pi 会话', canonical(b))];
    const map = recordContinuation(recordContinuation({}, a, b), b, c);
    const visible = applyContinuations(list, map, {}, keyOf, '未命名 pi 会话');
    expect(visible.map(x => x.name)).toEqual(['链头名']);
  });

  it('回归：subagent 子会话（独立文件，parentSession 指向被延续的源）不被误判为延续产物', () => {
    // P1-a：subagent 的 parentSession 恰好指向被 fork 的源文件，判别器必须用「path 是 map value」而非「parentSession 是 key」。
    const a = mkfile('src.jsonl'), b = mkfile('forked.jsonl'), sub = mkfile('sub.jsonl');
    const list = [s(canonical(a), '主线'), s(canonical(sub), 'subagent 任务会话', canonical(a)), s(canonical(b), '未命名 pi 会话', canonical(a))];
    const visible = applyContinuations(list, { [canonical(a)]: canonical(b) }, {}, keyOf, '未命名 pi 会话');
    // 主线被延续隐藏；fork 延续条目显示且继承名字；subagent 子会话保留（渲染层 #62 按 parentSession 隐藏）。
    expect(visible).toHaveLength(2);
    const fork = visible.find(x => x.path === canonical(b))!;
    expect(fork.name).toBe('主线');
    expect(fork.parentSession).toBeUndefined();
    expect(visible.some(x => x.path === canonical(sub) && x.name === 'subagent 任务会话')).toBe(true);
  });

  it('断链中间文件（既非 key 也非 value）保留并原样显示', () => {
    const a = mkfile('a4.jsonl'), b = mkfile('b4.jsonl'), c = mkfile('c4.jsonl');
    // 外部产生的 B（不在映射）：A→C 直接映射，B 的 parentSession 指向 A —— B 不是 value → 不过滤。
    const list = [s(canonical(a), 'A'), s(canonical(b), 'B', canonical(a)), s(canonical(c), 'C', canonical(b))];
    const visible = applyContinuations(list, { [canonical(a)]: canonical(c) }, {}, keyOf, 'f');
    // A 被延续隐藏；B 断链保留；C 是延续产物且继承链头名字 A。
    expect(visible.map(x => x.name).sort()).toEqual(['A', 'B']);
    expect(visible.find(x => x.name === 'A')!.parentSession).toBeUndefined();
  });
  it('无映射时原样返回', () => {
    const list = [s('/x.jsonl', 'x', '/w.jsonl')];
    expect(applyContinuations(list, {}, {}, keyOf, 'f')).toEqual(list);
  });
});
