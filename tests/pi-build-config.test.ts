import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// `pnpm dist` invokes electron-builder without --config: package.json.build wins
// over electron-builder.yml. Test the configuration actually used for releases.
const root = path.resolve(__dirname, '..');
const { build } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

it('checks the prepared runtime before packaging', () => {
  expect(build.beforePack).toBe('scripts/before-pack.cjs');
  expect(fs.existsSync(path.join(root, build.beforePack))).toBe(true);
});

it('fails closed when the final packaging runtime destination is absent', async () => {
  const hook = require(path.join(root, build.afterPack));
  await expect(hook({
    packager: { projectDir: root, appInfo: { productFilename: 'PI Desktop' } },
    electronPlatformName: 'darwin',
    appOutDir: path.join(root, 'tests/fixtures/no-such-build-output'),
  })).rejects.toThrow('runtime 打包目标不存在');
});

it('ships the private runtime outside asar at Resources/pi-runtime', () => {
  expect(build.extraResources).toContainEqual({
    from: 'resources/pi-runtime',
    to: 'pi-runtime',
    filter: ['**/*', '!node_modules/.cache/**/*'],
  });
});

it('declares microphone usage in the effective macOS configuration', () => {
  expect(build.mac.extendInfo?.NSMicrophoneUsageDescription)
    .toBe('PI Desktop 需要麦克风权限以进行语音输入。');
});
