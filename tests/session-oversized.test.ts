import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex, fileKey } from '../src/main/pi/session-index';
import { MAX_SESSION } from '../src/main/pi/session-size';

// 2026-10-09 事故回归：96MB ashare 主会话跨过旧的 64MiB 读取上限后，parseFile 抛错、
// scan() 无旧缓存可回退 → 会话从 sessions 列表消失，侧栏显示「该项目还没有会话」。
// 期望：超限会话降级为「元数据可见」——列表照常显示，读取全量历史时才报可执行错误。
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-idx-')); dirs.push(root);
  const owned = path.join(root, 'desktop'); fs.mkdirSync(owned, { recursive: true });
  return { root, owned, index: new SessionIndex([root, owned], owned) };
}
const writeSession = (dir: string, name: string, lines: string[]) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};
const header = (id: string, cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString(), ...extra });
const userMsg = (id: string, text: string) => JSON.stringify({ type: 'message', id, parentId: null, timestamp: Date.now(), message: { role: 'user', content: text } });

describe('超限会话不再从侧栏消失', () => {
  it('会话超过 MAX_SESSION 时：列表仍返回（元数据+警告），history() 抛出可执行错误', () => {
    const { root, owned, index } = setup();
    const file = writeSession(owned, 'big.jsonl', [header('big-1', root), userMsg('u1', '第一个问题')]);
    // 稀疏撑到上限之上：写一个大 padding 行（JSON 里允许的额外字段），不必真占 512MB 磁盘
    const padding = JSON.stringify({ type: 'custom', customType: 'pad', data: { blob: 'x'.repeat(1024) } });
    const stream = fs.createWriteStream(file, { flags: 'a' });
    // 直接追加大量行把 size 推过上限（每行 ~1KB，512K 行 ≈ 512MB 太大；改用 fs.truncate 稀疏文件）
    stream.end();
    const fd = fs.openSync(file, 'r+');
    fs.ftruncateSync(fd, MAX_SESSION + 4096);
    fs.closeSync(fd);
    void padding;
    const sessions = index.scan();
    const found = sessions.find(s => s.key === fileKey(file));
    expect(found, 'oversized session must still appear in the sidebar list').toBeDefined();
    expect(found!.size).toBeGreaterThan(MAX_SESSION);
    expect(found!.cwd).toBe(root);
    expect(found!.name).toContain('第一个问题');
    expect(found!.warnings.join(' ')).toMatch(/读取上限/);
    // 全量读取拒绝并给出可执行提示（列表可见 ≠ 可载入历史）
    expect(() => index.history(fileKey(file))).toThrow(/读取上限/);
  });

  it('未超限会话行为不变：完整解析 + 历史可读', () => {
    const { root, owned, index } = setup();
    const file = writeSession(owned, 'ok.jsonl', [header('ok-1', root), userMsg('u1', '正常会话')]);
    const sessions = index.scan();
    const found = sessions.find(s => s.key === fileKey(file))!;
    expect(found).toBeDefined();
    expect(found.warnings).toEqual([]);
    const history = index.history(fileKey(file));
    expect(history.branch.map(e => e.id)).toContain('u1');
  });

  it('外部 CLI 会话（带 parentSession）超限同样元数据可见（ashare 导入链）', () => {
    const { root, owned, index } = setup();
    const external = path.join(root, 'ext.jsonl');
    fs.writeFileSync(external, [header('ext-1', root, { parentSession: '/tmp/root.jsonl' }), userMsg('u1', '外部会话')].join('\n') + '\n');
    const fd = fs.openSync(external, 'r+');
    fs.ftruncateSync(fd, MAX_SESSION + 1);
    fs.closeSync(fd);
    const found = index.scan().find(s => s.key === fileKey(external));
    expect(found).toBeDefined();
    expect(found!.parentSession).toBe('/tmp/root.jsonl');
    expect(found!.owned).toBe(false);
    void owned;
  });
});
