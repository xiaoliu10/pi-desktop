import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { PiAccounts } from '../src/main/pi/accounts';
import { discoverPi } from '../src/main/pi/environment';

// Never discover a real user installation, read credentials, or start a worker.
vi.mock('../src/main/pi/environment', () => ({ discoverPi: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const agentDir = '/unused-test-agent';
const message = '模型目录、账号登录和套餐额度查询需要 Desktop 内置 pi 运行时，但运行时缺失或不可用。共享 pi 配置不等于已安装内置运行时。开发环境请运行 pnpm runtime:prepare；安装版请重新安装包含内置运行时且匹配架构的安装包。';

describe.each([
  { name: 'missing executable', executable: null, launchArgs: ['/unused/cli.js'] },
  { name: 'missing bundled CLI entry', executable: '/unused/node', launchArgs: undefined },
])('$name', ({ executable, launchArgs }) => {
  it.each(['catalog', 'login', 'quota'] as const)('%s reports the runtime requirement before spawning', async operation => {
    vi.mocked(discoverPi).mockReturnValue({
      executable, launchArgs, version: null, supported: false,
      agentDir, sessionDirs: [], diagnostics: [], runtime: 'bundled',
    });
    const accounts = new PiAccounts(() => agentDir);
    try {
      if (operation === 'login') {
        expect(() => accounts.start('openai-codex')).toThrow(message);
      } else {
        const result = operation === 'catalog' ? accounts.catalog() : accounts.quota('zai');
        await expect(result).rejects.toThrow(message);
      }
      expect(discoverPi).toHaveBeenCalledTimes(1);
      expect(discoverPi).toHaveBeenCalledWith({ runtime: 'bundled', agentDir });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      accounts.dispose();
    }
  });
});
