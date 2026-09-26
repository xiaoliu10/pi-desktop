import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PiHost } from '../src/main/pi/host';
import { SettingsService } from '../src/main/pi/settings-service';

const roots: string[] = [], hosts: PiHost[] = [];
afterEach(() => { hosts.splice(0).forEach(h => h.dispose()); roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-autodelete-')));
  roots.push(root);
  const agent = path.join(root, 'agent'), data = path.join(root, 'data');
  fs.mkdirSync(agent); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'pi-desktop.json'), JSON.stringify({ agentDir: agent }));
  const host = new PiHost(data, path.resolve('extensions/desktop-policy/index.mjs'), () => {}, path.join(root, 'shared-skills'));
  hosts.push(host);
  const service = new SettingsService(host, data, path.resolve('extensions/desktop-policy'));
  return { root, service };
}

it('auto-delete preferences default to off with a 30-day retention', () => {
  const { service } = setup();
  expect(service.preferences()).toMatchObject({ autoDeleteArchived: false, autoDeleteArchivedDays: 30 });
});

it('persists and validates auto-delete preferences across restarts', () => {
  const { root, service } = setup();
  service.savePreferences({ autoDeleteArchived: true, autoDeleteArchivedDays: 180 });
  expect(service.preferences()).toMatchObject({ autoDeleteArchived: true, autoDeleteArchivedDays: 180 });
  const restarted = new SettingsService({} as never, path.join(root, 'data'), '');
  expect(restarted.preferences()).toMatchObject({ autoDeleteArchived: true, autoDeleteArchivedDays: 180 });
  expect(() => service.savePreferences({ autoDeleteArchivedDays: 45 as never })).toThrow('自动删除保留时长');
  expect(() => service.savePreferences({ autoDeleteArchived: 'yes' as never })).toThrow('自动删除开关');
  // 非法磁盘值回落默认，不抛出（与 archiveRetentionDays 口径一致）。
  fs.writeFileSync(path.join(root, 'data', 'desktop-preferences.json'), JSON.stringify({ autoDeleteArchived: true, autoDeleteArchivedDays: 13 }));
  expect(service.preferences()).toMatchObject({ autoDeleteArchived: true, autoDeleteArchivedDays: 30 });
});
