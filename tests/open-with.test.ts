import { describe, expect, it, vi } from 'vitest';
import { authorizeProjectCwd, listExternalApps, openWithApp, type OpenWithDeps } from '../src/main/pi/open-with';

const exists = (paths: string[]) => (p: string) => paths.includes(p);
/** cwd 存在且为目录（openWithApp 需要 statSync 注入，默认 fs.statSync 会碰真实磁盘）。 */
const statSyncDir = () => ({ isDirectory: () => true });
const statSyncFile = () => ({ isDirectory: () => false });
const statSyncMissing = () => { throw new Error('ENOENT'); };

describe('listExternalApps', () => {
  it('macOS：Finder 默认首位，探测 /Applications 与 ~/Applications 中已安装的白名单应用', async () => {
    const deps: OpenWithDeps = {
      platform: 'darwin',
      home: '/Users/test',
      existsSync: exists([
        '/System/Applications/Utilities/Terminal.app',
        '/Applications/WebStorm.app',
        '/Users/test/Applications/Visual Studio Code.app',
      ]),
      fileIcon: async p => `icon:${p}`,
    };
    const apps = await listExternalApps(deps);
    expect(apps.map(a => a.id)).toEqual(['finder', 'webstorm', 'vscode', 'terminal']);
    expect(apps[0]).toMatchObject({ name: 'Finder', kind: 'finder' });
    expect(apps.find(a => a.id === 'terminal')).toMatchObject({ path: '/System/Applications/Utilities/Terminal.app', kind: 'terminal' });
    expect(apps.find(a => a.id === 'vscode')?.path).toBe('/Users/test/Applications/Visual Studio Code.app');
    expect(apps.find(a => a.id === 'webstorm')?.icon).toBe('icon:/Applications/WebStorm.app');
  });

  it('macOS：未安装的应用不出现；图标失败不影响列表', async () => {
    const apps = await listExternalApps({
      platform: 'darwin',
      home: '/Users/test',
      existsSync: () => false,
      fileIcon: async () => { throw new Error('no icon'); },
    });
    expect(apps.map(a => a.id)).toEqual(['finder']);
    expect(apps[0].icon).toBeUndefined();
  });

  it('非 macOS：安全回退为系统文件管理器单项', async () => {
    for (const platform of ['linux', 'win32']) {
      const apps = await listExternalApps({ platform });
      expect(apps).toEqual([{ id: 'file-manager', name: 'File Manager', path: '', kind: 'finder' }]);
    }
  });

  it('排序：Finder 首位，IntelliJ/WebStorm/PyCharm/VSCode 居中，Terminal 最后', async () => {
    const apps = await listExternalApps({
      platform: 'darwin',
      home: '/Users/test',
      existsSync: exists([
        '/System/Applications/Utilities/Terminal.app',
        '/Applications/IntelliJ IDEA.app',
        '/Applications/WebStorm.app',
        '/Applications/PyCharm.app',
        '/Applications/Visual Studio Code.app',
      ]),
    });
    expect(apps.map(a => a.id)).toEqual(['finder', 'intellij-idea', 'webstorm', 'pycharm', 'vscode', 'terminal']);
    expect(apps[0].kind).toBe('finder');
    expect(apps[apps.length - 1].kind).toBe('terminal');
  });
});

describe('openWithApp', () => {
  it('用 /usr/bin/open 按 argv 启动（无 shell），带空格路径原样传递', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const apps = await listExternalApps({ platform: 'darwin', home: '/u', existsSync: exists(['/Applications/Visual Studio Code.app']) });
    await openWithApp('/Users/test/My Project', 'vscode', { platform: 'darwin', run, statSync: statSyncDir }, apps);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', '/Applications/Visual Studio Code.app', '/Users/test/My Project']);
  });

  it('Terminal 用 -a bundle 路径打开目录（外部终端窗口）', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const apps = await listExternalApps({ platform: 'darwin', home: '/u', existsSync: exists(['/System/Applications/Utilities/Terminal.app']) });
    await openWithApp('/tmp/work dir', 'terminal', { platform: 'darwin', run, statSync: statSyncDir }, apps);
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', '/System/Applications/Utilities/Terminal.app', '/tmp/work dir']);
  });

  it('Finder 直接 open 目录', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await openWithApp('/Users/test/proj', 'finder', { platform: 'darwin', run, statSync: statSyncDir }, [{ id: 'finder', name: 'Finder', path: '/System/Library/CoreServices/Finder.app', kind: 'finder' }]);
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['/Users/test/proj']);
  });

  it('未知应用 id 拒绝（渲染端无法注入可执行路径）', async () => {
    const run = vi.fn();
    await expect(openWithApp('/tmp', '/Applications/Evil.app', { platform: 'darwin', run }, [])).rejects.toThrow('未知的外部应用');
    await expect(openWithApp('/tmp', 'evil', { platform: 'darwin', run }, [])).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('非法 cwd / appId 拒绝', async () => {
    await expect(openWithApp('relative/dir', 'finder', { platform: 'darwin', run: vi.fn() }, [])).rejects.toThrow('打开参数无效');
    await expect(openWithApp('/tmp', 42 as unknown as string, { platform: 'darwin', run: vi.fn() }, [])).rejects.toThrow('打开参数无效');
  });

  it('file-manager 回退走 openPath（系统文件管理器）', async () => {
    const openPath = vi.fn().mockResolvedValue(undefined);
    await openWithApp('/home/test/proj', 'file-manager', { platform: 'linux', openPath, statSync: statSyncDir });
    expect(openPath).toHaveBeenCalledWith('/home/test/proj');
  });

  it('已删除的项目目录（cwd 不存在）拒绝打开，不启动任何命令', async () => {
    const run = vi.fn();
    const apps = [{ id: 'finder', name: 'Finder', path: '/System/Library/CoreServices/Finder.app', kind: 'finder' as const }];
    await expect(openWithApp('/Users/test/deleted-dir', 'finder', { platform: 'darwin', run, statSync: statSyncMissing }, apps)).rejects.toThrow('项目目录不存在，请刷新。');
    expect(run).not.toHaveBeenCalled();
  });

  it('cwd 指向文件而非目录时拒绝打开，不启动任何命令', async () => {
    const run = vi.fn();
    const apps = [{ id: 'finder', name: 'Finder', path: '/System/Library/CoreServices/Finder.app', kind: 'finder' as const }];
    await expect(openWithApp('/Users/test/a-file.txt', 'finder', { platform: 'darwin', run, statSync: statSyncFile }, apps)).rejects.toThrow('项目路径不是目录，请刷新。');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('authorizeProjectCwd', () => {
  it('接受已知项目 / 会话 / 运行中工作区目录', () => {
    expect(authorizeProjectCwd('/Users/test/proj', ['/Users/test/other', '/Users/test/proj'])).toBe('/Users/test/proj');
  });

  it('拒绝未授权目录', () => {
    expect(() => authorizeProjectCwd('/etc', ['/Users/test/proj'])).toThrow('项目不存在');
    expect(() => authorizeProjectCwd('/Users/test/unknown-xyz', [])).toThrow('项目不存在');
  });

  it('拒绝相对路径与非字符串', () => {
    expect(() => authorizeProjectCwd('proj', ['/Users/test/proj'])).toThrow('项目路径无效');
    expect(() => authorizeProjectCwd(undefined, [])).toThrow('项目路径无效');
  });
});
