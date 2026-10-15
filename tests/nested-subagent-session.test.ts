import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/main/pi/session-index';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nested-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeSession(file: string, header: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'id-' + path.basename(file, '.jsonl').slice(0, 8), cwd: '/w', ...header }) + '\n');
}

describe('嵌套子会话（pi-subagents async 布局）', () => {
  it('顶层正常会话不受影响', () => {
    writeSession(path.join(root, 'main.jsonl'), {});
    const idx = new SessionIndex([root], root);
    const list = idx.scan();
    expect(list).toHaveLength(1);
    expect(list[0]!.parentSession).toBeUndefined();
  });
  it('显式 parentSession 头照常保留', () => {
    writeSession(path.join(root, 'main.jsonl'), {});
    writeSession(path.join(root, 'child-a', 'run-0', 'session.jsonl'), { parentSession: '/explicit/parent.jsonl' });
    const idx = new SessionIndex([root], root);
    const child = idx.scan(true).find(s => s.path.includes('child-a'));
    expect(child?.parentSession).toBe('/explicit/parent.jsonl');
  });
  it('无标记的嵌套子会话按路径推断 parentSession（侧栏过滤生效）', () => {
    writeSession(path.join(root, '1791817610336_main.jsonl'), { cwd: '/w' });
    writeSession(path.join(root, '1791817610336_main', 'a333bcdd', 'run-0', 'session.jsonl'), { cwd: '/w2' });
    // 主会话专属目录名 = 主会话文件名去掉 .jsonl
    const idx = new SessionIndex([root], root);
    const all = idx.scan(true);
    const child = all.find(s => s.path.includes('run-0'))!;
    expect(child).toBeTruthy();
    expect(child.parentSession).toBe(fs.realpathSync(path.join(root, '1791817610336_main.jsonl')));
    expect(all.find(s => path.basename(s.path) === '1791817610336_main.jsonl')?.parentSession).toBeUndefined();
  });
  it('updates cached parent metadata when the owning file is created and removed', () => {
    const parent = path.join(root, 'main.jsonl');
    writeSession(path.join(root, 'main', 'child', 'run-0', 'session.jsonl'), {});
    const idx = new SessionIndex([root], root);
    const child = () => idx.scan(true).find(s => s.path.includes('run-0'))!;
    expect(child().parentSession).toBeUndefined();
    writeSession(parent, {});
    expect(child().parentSession).toBe(fs.realpathSync(parent));
    fs.unlinkSync(parent);
    expect(child().parentSession).toBeUndefined();
  });
  it('finds the owner through overlapping scan roots', () => {
    writeSession(path.join(root, 'main.jsonl'), {});
    const childRoot = path.join(root, 'main', 'child', 'run-0');
    writeSession(path.join(childRoot, 'session.jsonl'), {});
    const idx = new SessionIndex([root, path.join(root, 'main'), childRoot], root);
    expect(idx.scan(true).find(s => s.path.includes('run-0'))?.parentSession).toBe(fs.realpathSync(path.join(root, 'main.jsonl')));
  });
  it('does not infer an owner from a directory or symlink named .jsonl', () => {
    writeSession(path.join(root, 'main', 'child', 'session.jsonl'), {});
    fs.mkdirSync(path.join(root, 'main.jsonl'));
    const idx = new SessionIndex([root], root);
    expect(idx.scan(true)[0].parentSession).toBeUndefined();
    fs.rmdirSync(path.join(root, 'main.jsonl'));
    fs.symlinkSync(path.join(root, 'main', 'child', 'session.jsonl'), path.join(root, 'main.jsonl'));
    expect(idx.scan(true)[0].parentSession).toBeUndefined();
  });
  it('根下无同名主会话的孤立嵌套目录不误标', () => {
    writeSession(path.join(root, 'orphan', 'x', 'session.jsonl'), { cwd: '/w' });
    const idx = new SessionIndex([root], root);
    const s = idx.scan(true).find(x => x.path.includes('orphan'))!;
    expect(s.parentSession).toBeUndefined();
  });
});
