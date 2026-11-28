import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjectDefaultModel } from '../src/main/pi/model-catalog';
import { composerModelId } from '../src/renderer/pi/adapter';

// 项目级 .pi/settings.json 的 defaultProvider/defaultModel 是 pi 内核选模依据之一
// （SettingsManager projectTrusted 默认 true）。Desktop 的输入框此前只显示全局默认，
// 用户在「新任务」看到的模型与 pi 实际要用的不同，一点模型菜单就会把会话固定到全局
// 供应商（2026-11 ashare-quant-agent 事故：项目级 ccr-project-… 被顶成全局 ccr）。
const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-default-'));
  roots.push(dir);
  return dir;
}

describe('readProjectDefaultModel（<cwd>/.pi/settings.json 只读解析）', () => {
  it('读出 defaultProvider/defaultModel', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.pi'));
    fs.writeFileSync(path.join(dir, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'ccr-project-x', defaultModel: 'ccr-opus' }));
    expect(readProjectDefaultModel(dir)).toEqual({ provider: 'ccr-project-x', model: 'ccr-opus' });
  });

  it('没有 .pi/settings.json 或字段缺失/非字符串时返回 undefined', () => {
    const empty = tmp();
    expect(readProjectDefaultModel(empty)).toBeUndefined();
    const onlyProvider = tmp();
    fs.mkdirSync(path.join(onlyProvider, '.pi'));
    fs.writeFileSync(path.join(onlyProvider, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'p' }));
    expect(readProjectDefaultModel(onlyProvider)).toBeUndefined();
    const nonString = tmp();
    fs.mkdirSync(path.join(nonString, '.pi'));
    fs.writeFileSync(path.join(nonString, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 1, defaultModel: 2 }));
    expect(readProjectDefaultModel(nonString)).toBeUndefined();
  });

  it('JSON 损坏时静默返回 undefined（显示层兜底，不让会话起不来）', () => {
    const bad = tmp();
    fs.mkdirSync(path.join(bad, '.pi'));
    fs.writeFileSync(path.join(bad, '.pi', 'settings.json'), '{ not json');
    expect(readProjectDefaultModel(bad)).toBeUndefined();
  });

  it('路径不存在/不可读不抛错', () => {
    expect(readProjectDefaultModel(path.join(os.tmpdir(), 'definitely-not-here-xyz'))).toBeUndefined();
  });
});

describe('composerModelId（输入框模型显示的取值顺序）', () => {
  const catalog = { defaultProvider: 'ccr', defaultModel: 'ccr-opus' };
  const projectDefault = { provider: 'ccr-project-x', model: 'ccr-opus' };

  it('新任务页优先显示项目级默认，而不是全局默认', () => {
    const id = composerModelId({ selectedKey: null, draftCwd: '/proj', draftModels: {}, catalog } as never, projectDefault);
    expect(id).toBe('ccr-project-x/ccr-opus');
  });

  it('无项目级默认时退回全局默认（现状不变）', () => {
    expect(composerModelId({ selectedKey: null, draftCwd: '/proj', draftModels: {}, catalog } as never, undefined)).toBe('ccr/ccr-opus');
  });

  it('用户本次显式选择的草稿仍最优先（一次性）', () => {
    const id = composerModelId({ selectedKey: null, draftCwd: '/proj', draftModels: { 'home:/proj': 'q/m9' }, catalog } as never, projectDefault);
    expect(id).toBe('q/m9');
  });

  it('已选会话（含被腾位的会话）不受项目级默认影响：会话的模型以自身历史为准', () => {
    expect(composerModelId({ selectedKey: 'kA', draftModels: {}, catalog } as never, projectDefault)).toBe('ccr/ccr-opus');
    expect(composerModelId({ selectedKey: 'kA', draftModels: { kA: 'q/m9' }, catalog } as never, projectDefault)).toBe('q/m9');
  });
});
