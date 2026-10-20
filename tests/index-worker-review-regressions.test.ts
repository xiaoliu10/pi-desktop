import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiHost } from '../src/main/pi/host';
import type { UsageStats } from '../src/main/pi/usage-stats';

const roots: string[] = [];
const hosts: PiHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach(host => host.dispose());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-review-')));
  roots.push(root);
  const agent = path.join(root, 'agent');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const owned = path.join(agent, 'sessions', 'desktop');
  fs.mkdirSync(owned, { recursive: true });
  for (let n = 0; n < 50; n++) fs.writeFileSync(path.join(owned, `${n}.jsonl`), JSON.stringify({ type: 'session', version: 3, id: String(n), cwd: root }) + '\n');
  fs.writeFileSync(path.join(data, 'pi-desktop.json'), JSON.stringify({ agentDir: agent, runtime: 'bundled' }));
  const events: string[] = [];
  const host = new PiHost(data, path.resolve('extensions/desktop-policy/index.mjs'), event => events.push(event.type));
  hosts.push(host);
  return { host, agent, events };
}

describe('worker review application integration', () => {
  it('P0-1/P1-5 normal startup creates a window without awaiting index readiness', () => {
    const source = fs.readFileSync('src/main/index.ts', 'utf8');
    const startup = source.slice(source.indexOf('void app.whenReady().then('));
    const normalStartup = startup.replace(/\/\/[^\n]*/g, '').replace(/if \(process.env.PI_SMOKE === '1'\) \{[\s\S]*?\n  \}/, '');
    expect(normalStartup.slice(0, normalStartup.indexOf('  createWindow();'))).not.toMatch(/await host.ready\(\)/);
    expect(startup).toContain("host.ready().then(() => broadcast({ type: 'sessions-changed' }))");
    // The renderer's existing ready=false loading state remains until the first sessions RPC resolves.
    expect(source).toMatch(/handle\('sessions', async \(\) => \{[\s\S]*?await host.ready\(\)/);
  });

  it('P1-4 configure returns a Promise and resolves with the first snapshot already populated', async () => {
    const { host, agent, events } = setup();
    await host.ready();
    events.length = 0;
    const configured = host.configure({ runtime: 'bundled', agentDir: agent });
    expect(configured).toBeInstanceOf(Promise);
    await configured;
    expect(host.index.sessionsView()).toHaveLength(50);
    expect(events).toContain('sessions-changed');
  });

  it('P1-6 host delegates aggregation to usageStatsAsync, caching only the aggregate', async () => {
    const { host } = setup();
    await host.ready();
    const stats: UsageStats = { sessions: 50, userMessages: 0, assistantMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, byModel: [], byDay: [], byProject: [] };
    const owner = vi.spyOn(host.index, 'usageStatsAsync').mockResolvedValue(stats);
    expect(await host.usageStats()).toBe(stats);
    expect(await host.usageStats()).toBe(stats);
    expect(owner).toHaveBeenCalledTimes(1);
  });
});
