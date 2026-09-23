#!/usr/bin/env node
/**
 * UI preview launcher (U07): starts the Vite dev server on a dedicated port
 * and prints the ?preview=1 entry. The preview is plain web — no Electron,
 * no model, no user files.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.PREVIEW_PORT ?? '5174';

const vite = spawn('pnpm', ['exec', 'vite', '--port', PORT, '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const url = `http://127.0.0.1:${PORT}/?preview=1`;
console.log(`\n[preview-ui] starting Vite… open ${url} once ready\n`);

vite.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    vite.kill('SIGTERM');
    process.exit(0);
  });
}
