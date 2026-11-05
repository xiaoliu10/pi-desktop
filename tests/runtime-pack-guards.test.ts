import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const beforePack = require(path.join(root, 'scripts/before-pack.cjs'));

it('runs the original platform/architecture guard before copying runtime', async () => {
  await expect(beforePack({
    packager: { projectDir: root, appInfo: { productFilename: 'PI Desktop' } },
    electronPlatformName: 'linux',
    arch: 1,
    appOutDir: path.join(root, 'tests/fixtures/no-such-build-output'),
  })).rejects.toThrow('运行时架构不匹配');
});

it('fails when the source runtime is incomplete', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'tests/.tmp-pack-guard-'));
  fs.mkdirSync(path.join(dir, 'resources/pi-runtime'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources/pi-runtime/runtime.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64' }));
  try {
    await expect(beforePack({
      packager: { projectDir: dir, appInfo: { productFilename: 'PI Desktop' } },
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir: path.join(dir, 'out'),
    })).rejects.toThrow('运行时不完整');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
