import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairPackages } from '../src/main/pi/packages-repair';

// 同一个包被注册两遍（npm:X@^0.0.1 与 npm:X）是 v0.1.47 用户实测到的脏数据：
// 精确字符串比对把「带版本范围」和「裸名」当成两个包，repairPackages 每次启动
// 都往 settings.json 追加一条，期望列表（pi-desktop.json）同样被污染。
// 重复注册本身未必让 pi 报错，但它让「谁提供了这个工具」无法判定，也是
// desktop_update_plan 双注册冲突长期排查不清的一部分。
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })));

function setup(settings: Record<string, any>, desired: string[], npmDeps: Record<string, string> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-repair-')));
  roots.push(root);
  const agentDir = path.join(root, 'agent'), dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(agentDir, 'npm'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(agentDir, 'npm', 'package.json'), JSON.stringify({ dependencies: npmDeps }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'pi-desktop.json'), JSON.stringify({ piPackages: desired }, null, 2));
  return { agentDir, dataDir };
}
const read = (agentDir: string) => JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).packages ?? [];

describe('repairPackages 按包名去重', () => {
  it('期望列表是裸名、已注册带版本范围 → 不再追加重复条目', () => {
    const { agentDir, dataDir } = setup(
      { packages: ['npm:@wengine-ai/pi-plan-tool@^0.0.1'] },
      ['npm:@wengine-ai/pi-plan-tool'],
      { '@wengine-ai/pi-plan-tool': '^0.0.1' },
    );
    expect(repairPackages(dataDir, agentDir)).toEqual([]);
    expect(read(agentDir)).toEqual(['npm:@wengine-ai/pi-plan-tool@^0.0.1']);
  });

  it('期望列表带版本范围、已注册裸名 → 同样视为已注册', () => {
    const { agentDir, dataDir } = setup(
      { packages: ['npm:@wengine-ai/pi-subagents'] },
      ['npm:@wengine-ai/pi-subagents@^0.79.1'],
      { '@wengine-ai/pi-subagents': '^0.79.3' },
    );
    expect(repairPackages(dataDir, agentDir)).toEqual([]);
    expect(read(agentDir)).toEqual(['npm:@wengine-ai/pi-subagents']);
  });

  it('期望列表自身重复 → 只补一条', () => {
    const { agentDir, dataDir } = setup(
      { packages: [] },
      ['npm:@wengine-ai/pi-plan-tool', 'npm:@wengine-ai/pi-plan-tool@^0.0.1'],
      { '@wengine-ai/pi-plan-tool': '^0.0.1' },
    );
    const restored = repairPackages(dataDir, agentDir);
    expect(restored).toHaveLength(1);
    expect(read(agentDir)).toHaveLength(1);
  });

  it('已存在的重复条目在写回时被折叠（保留首次出现的那条）', () => {
    const { agentDir, dataDir } = setup(
      { packages: ['npm:@wengine-ai/pi-plan-tool@^0.0.1', 'npm:@wengine-ai/pi-plan-tool', 'npm:pi-lens'] },
      ['npm:pi-goal-x'],
      { '@wengine-ai/pi-plan-tool': '^0.0.1', 'pi-goal-x': '^0.32.3', 'pi-lens': '^4.4.4' },
    );
    repairPackages(dataDir, agentDir);
    expect(read(agentDir)).toEqual(['npm:@wengine-ai/pi-plan-tool@^0.0.1', 'npm:pi-lens', 'npm:pi-goal-x']);
  });

  it('真的缺注册时照常补回（去重不能顺手废掉自愈）', () => {
    const { agentDir, dataDir } = setup(
      { packages: ['npm:pi-lens'] },
      ['npm:@wengine-ai/pi-plan-tool'],
      { '@wengine-ai/pi-plan-tool': '^0.0.1', 'pi-lens': '^4.4.4' },
    );
    expect(repairPackages(dataDir, agentDir)).toEqual(['npm:@wengine-ai/pi-plan-tool']);
    expect(read(agentDir)).toEqual(['npm:pi-lens', 'npm:@wengine-ai/pi-plan-tool']);
  });

  it('已卸载的包不补回', () => {
    const { agentDir, dataDir } = setup({ packages: [] }, ['npm:@wengine-ai/pi-plan-tool'], {});
    expect(repairPackages(dataDir, agentDir)).toEqual([]);
    expect(read(agentDir)).toEqual([]);
  });

  it('没有重复也没有缺失时不写文件', () => {
    const { agentDir, dataDir } = setup(
      { packages: ['npm:pi-lens'] },
      ['npm:pi-lens'],
      { 'pi-lens': '^4.4.4' },
    );
    const before = fs.statSync(path.join(agentDir, 'settings.json')).mtimeMs;
    expect(repairPackages(dataDir, agentDir)).toEqual([]);
    expect(fs.statSync(path.join(agentDir, 'settings.json')).mtimeMs).toBe(before);
  });
});
