import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { PiAccounts } from '../src/main/pi/accounts';
import { ACCOUNT_WORKER } from '../src/main/pi/account-worker';
import { mergeModelCatalog } from '../src/main/pi/model-catalog';
import { discoverPi } from '../src/main/pi/environment';

// Never touch a real installation, credentials, or worker process.
vi.mock('../src/main/pi/environment', () => ({ discoverPi: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const agentDir = '/unused-test-agent';

function mockEnv() {
  vi.mocked(discoverPi).mockReturnValue({
    executable: '/unused/node', launchArgs: ['/unused/cli.js'], version: null,
    supported: false, agentDir, sessionDirs: [], diagnostics: [], runtime: 'bundled',
  });
}

/** Minimal pipe child: stdout is a real stream so readline works. */
function fakeChild() {
  const child: any = new EventEmitter();
  const { PassThrough } = require('node:stream') as typeof import('node:stream');
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.write = vi.fn();
  child.kill = vi.fn();
  return child as import('node:child_process').ChildProcessWithoutNullStreams;
}

describe('accounts.generate input validation (before any spawn)', () => {
  it.each([
    ['../evil', 'img', 'a cat', '提供商无效'],
    ['ok', 'bad model!', 'a cat', '模型无效'],
    ['ok', 'img', '', '请输入 1–4000 字的生图描述'],
    ['ok', 'img', 'x'.repeat(4001), '请输入 1–4000 字的生图描述'],
  ])('rejects provider=%s model=%s', async (provider, model, prompt, message) => {
    mockEnv();
    const accounts = new PiAccounts(() => agentDir);
    await expect(accounts.generate(provider, model, prompt)).rejects.toThrow(message);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('accounts.generate worker protocol', () => {
  it('resolves with whitelisted images and passes model+prompt via worker argv', async () => {
    mockEnv();
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const accounts = new PiAccounts(() => agentDir);
    const pending = accounts.generate('openrouter', 'google/gemini-image', ' 一只柴犬 ');
    await new Promise(r => setImmediate(r));
    // payload 走 argv 第 6 位（worker 的 payloadJson），prompt 已 trim。
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.slice(-3)).toEqual(['generate', 'openrouter', JSON.stringify({ model: 'google/gemini-image', prompt: '一只柴犬' })]);
    child.stdout.write(JSON.stringify({ type: 'images', images: [
      { mime: 'image/png', data: 'AAAA' },
      { mime: 'text/html', data: 'DROPME' },        // mime 白名单外
      { mime: 'image/png', data: '' },              // 空 data
    ] }) + '\n');
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ images: [{ mime: 'image/png', data: 'AAAA' }] });
    expect(child.stdin.write).not.toHaveBeenCalled(); // 生图无需 stdin 交互
  });

  it('rejects with the worker error message (our static strings carry a code)', async () => {
    mockEnv();
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const accounts = new PiAccounts(() => agentDir);
    const pending = accounts.generate('openrouter', 'img', 'a cat');
    await new Promise(r => setImmediate(r));
    child.stdout.write(JSON.stringify({ type: 'error', message: '该提供商没有这个图像模型' }) + '\n');
    child.emit('close', 1);
    await expect(pending).rejects.toThrow('该提供商没有这个图像模型');
  });

  it('rejects with exit code when the worker dies silently', async () => {
    mockEnv();
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const accounts = new PiAccounts(() => agentDir);
    const pending = accounts.generate('openrouter', 'img', 'a cat');
    await new Promise(r => setImmediate(r));
    child.emit('close', 2);
    await expect(pending).rejects.toThrow('退出码 2');
  });
});

describe('worker source contract', () => {
  it('generate op guards runtime capability, resolves the image model, and forwards only coded errors', () => {
    expect(ACCOUNT_WORKER).toContain("operation==='generate'");
    // 旧运行时（<0.99 无 generateImages）给出可行动的错误而不是崩
    expect(ACCOUNT_WORKER).toContain("typeof runtime.generateImages!=='function'");
    expect(ACCOUNT_WORKER).toContain("getModelOfType('image',providerId");
    expect(ACCOUNT_WORKER).toContain('stopReason===\'error\'');
    // 错误按码转发（静态文案）；无码（SDK/网络栈）仍走通用文案，不带凭证
    expect(ACCOUNT_WORKER).toContain('err&&err.code?');
    // catalog 汇出 imageModels，旧运行时降级为空
    expect(ACCOUNT_WORKER).toContain("getModelsOfType('image',p.id)");
    // prompt 上限与 worker 侧一致（1–4000 字）
    expect(ACCOUNT_WORKER).toContain('slice(0,4000)');
  });
});

describe('mergeModelCatalog image models', () => {
  it('syncs imageModels from the native catalog onto an existing local provider', () => {
    const local = mergeModelCatalog({
      providers: [{ id: 'openrouter', name: '本地覆盖', auth: 'api_key', source: 'models.json', models: [{ id: 'm1' }] }],
    }, [{
      id: 'openrouter', name: 'openrouter', auth: 'oauth', source: 'auth', models: [],
      imageModels: [{ id: 'gemini-image', name: 'Gemini Image' }],
    }]);
    expect(local.providers[0].imageModels).toEqual([{ id: 'gemini-image', name: 'Gemini Image' }]);
    // 本地模型列表不受影响
    expect(local.providers[0].models).toHaveLength(1);
  });
});
