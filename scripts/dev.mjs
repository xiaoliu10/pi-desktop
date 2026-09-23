#!/usr/bin/env node
/**
 * Dev orchestrator: starts Vite dev server, compiles main/preload with tsc, then
 * launches Electron pointed at the dev server.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VITE_PORT = 5173;

function waitPort(port, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`port ${port} not ready`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

const procs = [];
function run(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tag = `[${name}]`;
  p.stdout.on('data', (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  p.stderr.on('data', (d) => process.stderr.write(d.toString().split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  procs.push(p);
  return p;
}

function cleanup() {
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

run('tsc', 'pnpm', ['exec', 'tsc', '-p', 'tsconfig.main.json']);
run('vite', 'pnpm', ['exec', 'vite']);

console.log('[dev] waiting for Vite dev server…');
await waitPort(VITE_PORT);
console.log('[dev] launching Electron');

const electron = run('electron', 'pnpm', ['exec', 'electron', '.'], {
  env: { ...process.env, PI_VITE_URL: `http://127.0.0.1:${VITE_PORT}`, NODE_ENV: 'development' },
});
electron.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
