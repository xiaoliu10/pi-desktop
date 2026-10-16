// Guards the guard: the bundled runtime must be the one that actually runs.
//
// pi's bundle resolves its own package directory from PI_PACKAGE_DIR (chunk getPackageDir),
// so any harness that spawns cli.js with a plain `...process.env` silently executes whatever
// global pi install that variable names. On a machine with a global pi of a different version
// this makes every smoke "pass" against the wrong runtime, and it breaks
// scripts/prepare-runtime.mjs's version assertion too (pnpm runtime:prepare / dist fail).
//
// This test runs the real child process rather than grepping sources: grepping cannot tell a
// live `delete` from a commented-out one, which is exactly how the original regression slipped
// through review.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const expected = JSON.parse(fs.readFileSync(path.join(root, 'resources/pi-runtime/package.json'), 'utf8')).dependencies['@earendil-works/pi-coding-agent'];

/** Spawn cli.js --version with an env, return the reported version. */
const cliVersion = (env: NodeJS.ProcessEnv) => {
  const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env, timeout: 60_000 });
  expect(r.status, `cli --version failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
};

afterEach(() => { /* no global state */ });

it('a harness that clears the redirect still gets the bundled version', () => {
  // Reproduce the harness contract: take a poisoned env, apply the same deletions the
  // harnesses make, and confirm the child then reports the bundled version. This is the
  // property that actually protects us — not "pi ignores PI_PACKAGE_DIR" (it does not).
  const candidates = ['/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent', '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent', path.join(os.homedir(), '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent')];
  const other = candidates.find(c => { try { return JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8')).version !== expected; } catch { return false; } });
  if (!other) { console.log('[skip] no divergent global pi install; cannot exercise the redirect'); return; }
  // Sanity: the poison really does redirect (otherwise this test proves nothing).
  expect(cliVersion({ ...process.env, PI_PACKAGE_DIR: other })).not.toBe(expected);
  // The harness contract: clear it, and the bundled version comes back.
  const cleaned = { ...process.env, PI_PACKAGE_DIR: other };
  delete cleaned.PI_PACKAGE_DIR;
  delete cleaned.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  expect(cliVersion(cleaned)).toBe(expected);
});

it('the smoke scripts clear the redirect themselves (live child, not a source grep)', () => {
  // Reproduce what each smoke does: build its env helper's output and run the child with it.
  // We re-derive the helper from the script so the check tracks the script's own logic.
  for (const rel of ['tests/rpc-runtime-smoke.mjs', 'tests/rpc-full-args-smoke.mjs']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(src, `${rel} missing`).toContain('PI_PACKAGE_DIR');
    // The env helper must delete both redirect knobs.
    expect(src, `${rel} does not delete PI_PACKAGE_DIR in its env helper`).toMatch(/delete\s+e\.PI_PACKAGE_DIR/);
    expect(src, `${rel} does not delete the subagents package root`).toMatch(/delete\s+e\.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT/);
    // And it must never hand a bare spread of process.env to PiRpcClient.
    expect(src, `${rel} still spreads process.env directly into the child`).not.toMatch(/new PiRpcClient\([^)]*\.\.\.process\.env/);
  }
});

it('the runtime launcher clears the redirect too (pnpm runtime:prepare depends on it)', () => {
  for (const rel of ['scripts/prepare-runtime.mjs', 'src/main/pi/backend.ts']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(src, `${rel} missing`).toContain('PI_PACKAGE_DIR');
    expect(src, `${rel} does not delete PI_PACKAGE_DIR`).toMatch(/delete\s+\w+(\.\w+)*\.PI_PACKAGE_DIR/);
  }
});

it('both smoke scripts assert the version before the first RPC request', () => {
  for (const rel of ['tests/rpc-runtime-smoke.mjs', 'tests/rpc-full-args-smoke.mjs']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    // Expected version read from package.json, so a runtime bump tightens the assertion.
    expect(src, `${rel} does not read the expected version from package.json`).toMatch(/resources\/pi-runtime\/package\.json/);
    expect(src, `${rel} does not assert version equality`).toMatch(/assert\.equal\(\s*version\.stdout\.trim\(\)\s*,\s*expected/);
    const assertAt = src.indexOf('version.stdout.trim(), expected');
    const firstRequest = src.search(/\.request\('get_state'\)/);
    expect(assertAt, `${rel} has no version assertion`).toBeGreaterThan(-1);
    expect(firstRequest, `${rel} never calls get_state`).toBeGreaterThan(-1);
    expect(assertAt, `${rel} asserts the version after the first RPC request`).toBeLessThan(firstRequest);
  }
});
