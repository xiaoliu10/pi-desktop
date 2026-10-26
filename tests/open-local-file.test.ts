import { describe, expect, it } from 'vitest';
import { openLocalFile } from '../src/main/pi/open-local-file';

function fixture(kind: 'file' | 'directory' | 'missing' = 'file') {
  const calls = { opened: [] as string[], revealed: [] as string[] };
  return {
    calls,
    deps: {
      statSync: (target: string) => {
        if (kind === 'missing') throw new Error('ENOENT');
        return { isDirectory: () => kind === 'directory', isFile: () => kind === 'file', path: target };
      },
      openPath: async (target: string) => { calls.opened.push(target); return ''; },
      showItemInFolder: (target: string) => { calls.revealed.push(target); },
    },
  };
}

describe('openLocalFile', () => {
  it('rejects relative paths and NUL bytes', async () => {
    const f = fixture();
    await expect(openLocalFile('diagram.png', f.deps)).rejects.toThrow();
    await expect(openLocalFile('/tmp/a\0.png', f.deps)).rejects.toThrow();
    await expect(openLocalFile(42, f.deps)).rejects.toThrow();
    expect(f.calls.opened).toEqual([]);
    expect(f.calls.revealed).toEqual([]);
  });
  it('reports missing files instead of silently doing nothing', async () => {
    const f = fixture('missing');
    await expect(openLocalFile('/tmp/gone.png', f.deps)).rejects.toThrow('不存在');
  });
  it.each(['.png', '.pdf', '.html', '.md', '.svg', '.txt'])('opens document %s with the system default app', async (ext) => {
    const f = fixture();
    await expect(openLocalFile('/tmp/report' + ext, f.deps)).resolves.toEqual({ action: 'opened' });
    expect(f.calls.opened).toEqual(['/tmp/report' + ext]);
    expect(f.calls.revealed).toEqual([]);
  });
  it.each(['.command', '.app', '.exe', '.xyz', ''])('never executes %s payloads from chat text: reveals instead', async (ext) => {
    const f = fixture();
    await expect(openLocalFile('/tmp/payload' + ext, f.deps)).resolves.toEqual({ action: 'revealed' });
    expect(f.calls.opened).toEqual([]);
    expect(f.calls.revealed).toEqual(['/tmp/payload' + ext]);
  });
  it('opens directories in the file manager', async () => {
    const f = fixture('directory');
    await expect(openLocalFile('/tmp/delivery', f.deps)).resolves.toEqual({ action: 'opened' });
    expect(f.calls.opened).toEqual(['/tmp/delivery']);
  });
  it('surfaces shell.openPath failures to the caller', async () => {
    const f = fixture();
    f.deps.openPath = async () => 'Permission denied';
    await expect(openLocalFile('/tmp/report.pdf', f.deps)).rejects.toThrow('Permission denied');
  });
});
