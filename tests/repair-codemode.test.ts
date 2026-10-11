import { afterEach, describe, expect, it } from 'vitest';
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

  it('tolerates missing/corrupt pi-desktop.json and settings.json', () => {
    const { data, agent } = setup(); // 两文件都不存在
    expect(repairCodemode(data, agent)).toBe(false);
    writeDesktop(data, 'not json');
    writeSettings(agent, 'not json');
    expect(repairCodemode(data, agent)).toBe(false);
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
