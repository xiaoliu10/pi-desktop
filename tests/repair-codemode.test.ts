import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordCodemodeDesired, repairCodemode } from '../src/main/pi/repair-codemode';

// 复刻 packages-repair 的同款防御场景：pi 退出整包写回内存旧副本抹掉 defaultTools。

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const setup = () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-repair-data-')); roots.push(data);
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-repair-agent-')); roots.push(agent);
  return { data, agent };
};
const writeSettings = (agent: string, doc: unknown) => fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify(doc));
const writeDesktop = (data: string, doc: unknown) => fs.writeFileSync(path.join(data, 'pi-desktop.json'), JSON.stringify(doc));

describe('repairCodemode', () => {
  it('restores +codemode when desired is true but settings lost it', () => {
    const { data, agent } = setup();
    writeDesktop(data, { codemode: true });
    writeSettings(agent, { theme: 'light', defaultProvider: 'ccr' }); // pi 写回抹掉了 defaultTools
    expect(repairCodemode(data, agent)).toBe(true);
    const restored = JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'));
    expect(restored.defaultTools).toEqual(['+codemode']);
  });

  it('is idempotent when +codemode is already in place', () => {
    const { data, agent } = setup();
    writeDesktop(data, { codemode: true });
    writeSettings(agent, { defaultTools: ['+codemode'] });
    expect(repairCodemode(data, agent)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')).defaultTools).toEqual(['+codemode']);
  });

  it('does not strip +codemode even when desired is false (CLI users keep manual control)', () => {
    const { data, agent } = setup();
    writeDesktop(data, { codemode: false });
    writeSettings(agent, { defaultTools: ['+codemode'] });
    expect(repairCodemode(data, agent)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')).defaultTools).toEqual(['+codemode']);
  });

  it('preserves other defaultTools entries when restoring', () => {
    const { data, agent } = setup();
    writeDesktop(data, { codemode: true });
    writeSettings(agent, { defaultTools: ['+memory'] });
    expect(repairCodemode(data, agent)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')).defaultTools).toEqual(['+memory', '+codemode']);
  });

  it('does nothing when no desired codemode is recorded', () => {
    const { data, agent } = setup();
    writeDesktop(data, { piPackages: [] }); // 无 codemode 字段
    writeSettings(agent, { defaultTools: [] });
    expect(repairCodemode(data, agent)).toBe(false);
  });

  it('tolerates missing pi-desktop.json and settings.json', () => {
    const { data, agent } = setup(); // 两文件都不存在
    expect(repairCodemode(data, agent)).toBe(false);
  });

  it('never overwrites a corrupt settings.json (P1: corrupt ≠ empty)', () => {
    const { data, agent } = setup();
    writeDesktop(data, { codemode: true });
    const original = '{"defaultProvider":"example","retry":'; // 截断的合法前缀
    fs.writeFileSync(path.join(agent, 'settings.json'), original);
    expect(repairCodemode(data, agent)).toBe(false);
    // 原文件字节未变（静默当空对象覆盖会丢掉用户全部配置）
    expect(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')).toBe(original);
  });

  it('recordCodemodeDesired refuses to clobber a corrupt pi-desktop.json', () => {
    const { data } = setup();
    const original = '{"piPackages":["npm:pi-memory"],'; // 截断
    fs.writeFileSync(path.join(data, 'pi-desktop.json'), original);
    expect(() => recordCodemodeDesired(data, true)).toThrow();
    expect(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8')).toBe(original);
  });

  it('writes atomically (no .tmp residue after repair)', () => {
    const { data, agent } = setup();
    writeDesktop(data, { codemode: true });
    writeSettings(agent, { theme: 'light' });
    expect(repairCodemode(data, agent)).toBe(true);
    expect(fs.readdirSync(agent).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

describe('recordCodemodeDesired', () => {
  it('records the desired state without clobbering other pi-desktop.json fields', () => {
    const { data } = setup();
    writeDesktop(data, { piPackages: ['npm:pi-memory'], runtime: 'bundled' });
    recordCodemodeDesired(data, true);
    const doc = JSON.parse(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8'));
    expect(doc.codemode).toBe(true);
    expect(doc.piPackages).toEqual(['npm:pi-memory']);
    expect(doc.runtime).toBe('bundled');
  });

  it('creates the file when it does not exist', () => {
    const { data } = setup();
    recordCodemodeDesired(data, false);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8')).codemode).toBe(false);
  });
});

describe('host.configure preserves the codemode desired record (review P2)', () => {
  it('configure merge keeps codemode/piPackages in pi-desktop.json', async () => {
    // 直接复刻 host.configure 的合并语义（host 构造需要完整 electron 环境太快，这里锁逻辑）
    const { data } = setup();
    writeDesktop(data, { codemode: true, piPackages: ['npm:pi-memory'] });
    const persisted: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8'));
    const preferences = { runtime: 'bundled' as const, agentDir: '/tmp/whatever' };
    const merged = { ...persisted, ...preferences };
    fs.writeFileSync(path.join(data, 'pi-desktop.json'), JSON.stringify(merged));
    const doc = JSON.parse(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8'));
    expect(doc.codemode).toBe(true);
    expect(doc.piPackages).toEqual(['npm:pi-memory']);
    expect(doc.agentDir).toBe('/tmp/whatever');
  });
});

describe('settings-service first snapshot reflects repair (review P2)', () => {
  it('first snapshot.codemode is true after repair restored defaultTools', async () => {
    vi.resetModules();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-integ-'))); roots.push(root);
    const agent = path.join(root, 'agent'), data = path.join(root, 'data');
    fs.mkdirSync(agent); fs.mkdirSync(data);
    // 项目先注册（snapshot 的 resources/roots 需要），agentDir 与 pi-desktop.json 对齐
    writeDesktop(data, { agentDir: agent, codemode: true });
    fs.writeFileSync(path.join(data, 'desktop-preferences.json'), JSON.stringify({ projects: [{ path: root }] }));
    writeSettings(agent, { theme: 'light', defaultProvider: 'ccr', defaultModel: 'ccr-opus' }); // 无 defaultTools
    const { SettingsService } = await import('../src/main/pi/settings-service');
    const { PiHost } = await import('../src/main/pi/host');
    const host = new PiHost(data, path.resolve('extensions/desktop-policy/index.mjs'), () => {}, undefined, '0.1.16');
    const settings = new SettingsService(host, data, path.resolve('extensions/desktop-policy'));
    const snap = settings.snapshot(root);
    expect(snap.ai.codemode).toBe(true); // 首次快照即修复后状态，不需要开两次设置页
    expect(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')).defaultTools).toEqual(['+codemode']);
    expect(snap.diagnostics.some(d => d.includes('codemode'))).toBe(true);
    host.dispose();
  });
});

describe('legacy user migration (review #4)', () => {
  it('records the desired state when settings already has +codemode but pi-desktop.json has no codemode field', () => {
    const { data, agent } = setup();
    writeDesktop(data, { piPackages: ['npm:pi-memory'] }); // 无 codemode 字段（旧版本不记录）
    writeSettings(agent, { defaultTools: ['+codemode'] }); // 用户之前一直开着
    expect(repairCodemode(data, agent)).toBe(false); // 已在位，本次不补
    // 但迁移已把期望写入 pi-desktop.json
    expect(JSON.parse(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8')).codemode).toBe(true);
  });

  it('migrates to false (not auto-enable) when settings has no +codemode', () => {
    const { data, agent } = setup();
    writeDesktop(data, { piPackages: [] });
    writeSettings(agent, { defaultTools: ['+memory'] });
    expect(repairCodemode(data, agent)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8')).codemode).toBe(false);
  });

  it('after migration, a subsequent pi-wipeout self-heals', () => {
    const { data, agent } = setup();
    writeDesktop(data, { piPackages: [] });
    writeSettings(agent, { defaultTools: ['+codemode'] });
    repairCodemode(data, agent); // 迁移记录期望 true
    // 模拟 pi 退出抹掉 defaultTools
    writeSettings(agent, { theme: 'light', defaultProvider: 'ccr' });
    expect(repairCodemode(data, agent)).toBe(true); // 自愈补回
    expect(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')).defaultTools).toEqual(['+codemode']);
  });
});

describe('host.configure corrupt-document protection (review #2)', () => {
  it('refuses to overwrite a corrupt pi-desktop.json', async () => {
    vi.resetModules();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-cfg-'))); roots.push(root);
    const data = path.join(root, 'data'); fs.mkdirSync(data);
    const corrupt = '{"piPackages":["npm:pi-memory"],'; // 截断
    fs.writeFileSync(path.join(data, 'pi-desktop.json'), corrupt);
    const { PiHost } = await import('../src/main/pi/host');
    const host = new PiHost(data, path.resolve('extensions/desktop-policy/index.mjs'), () => {}, undefined, '0.1.16');
    await expect(host.configure({ runtime: 'bundled', agentDir: path.join(root, 'agent') })).rejects.toThrow(/损坏/);
    // 原文件字节未变
    expect(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8')).toBe(corrupt);
    host.dispose();
  });

  it('configure preserves codemode/piPackages when merging a valid document', async () => {
    vi.resetModules();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-cfg2-'))); roots.push(root);
    const data = path.join(root, 'data'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'pi-desktop.json'), JSON.stringify({ codemode: true, piPackages: ['npm:pi-memory'] }));
    const { PiHost } = await import('../src/main/pi/host');
    const host = new PiHost(data, path.resolve('extensions/desktop-policy/index.mjs'), () => {}, undefined, '0.1.16');
    await host.configure({ runtime: 'bundled', agentDir: path.join(root, 'agent') });
    const doc = JSON.parse(fs.readFileSync(path.join(data, 'pi-desktop.json'), 'utf8'));
    expect(doc.codemode).toBe(true);
    expect(doc.piPackages).toEqual(['npm:pi-memory']);
    expect(doc.agentDir).toBe(path.join(root, 'agent'));
    host.dispose();
  });
});
