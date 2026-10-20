// npm run smoke:history-ipc (always compiles the current main-process source first).
// ELECTRON_RUN_AS_NODE must be unset; the guard below rejects Node-mode runs.
// Isolated test process: no production profile, sessions, extensions, or app entry.
const assert = require('node:assert/strict');
assert(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE, 'Run in Electron with ELECTRON_RUN_AS_NODE unset');
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RendererHistory } = require('../dist/main/pi/renderer-history.js');
assert(process.versions.electron, 'Must run in Electron, not ELECTRON_RUN_AS_NODE');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'history-ipc-bench-'));
app.setPath('userData', scratch);
let win;
let settled = false;
const finish = (code) => {
  if (settled) return;
  settled = true;
  win?.destroy();
  app.quit();
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = code;
};
app.whenReady().then(async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ type: 'message', id: String(i),
    parentId: i ? String(i - 1) : null,
    message: { role: i < 29 ? 'toolResult' : 'user', content: i < 29
      ? [{ type: 'text', text: 'image output' }, { type: 'image', mimeType: 'image/png',
        data: String.fromCharCode(65 + (i % 26)).repeat(1024 * 1024) }]
      : [{ type: 'text', text: 'entry ' + i }] } }));
  const raw = { session: { key: 'fixture', path: '/fixture', warnings: [] }, entries, branch: entries,
    leaves: ['499'], leafId: '499', syncedAt: 1, truncated: { total: 20_000, returned: 500 } };
  const projected = new RendererHistory().project(raw);
  assert.equal(raw.branch[0].message.content[1].data.length, 1024 * 1024);
  assert.equal(projected.branch[0].message.content[1].data, undefined);
  ipcMain.handle('history-bench', (_, mode) => mode === 'raw' ? raw : projected);
  win = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false,
  } });
  const html = path.join(scratch, 'bench.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><textarea id="input"></textarea>');
  await win.loadFile(html);
  // Invoke real Electron IPC from the renderer. Timer gaps measure responsiveness, not Event Timing.
  const results = await win.webContents.executeJavaScript('(' + (async () => {
    const { ipcRenderer } = require('electron');
    const runs = { raw: [], projected: [] };
    for (const mode of ['raw', 'projected', 'projected', 'raw']) {
      let maxGap = 0, last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const response = await ipcRenderer.invoke('history-bench', mode);
        const elapsed = performance.now() - start;
        if (response.branch.length !== 500) throw new Error('Lost branch rows');
        if (mode === 'projected' && response.branch[0].message.content[1].data !== undefined) throw new Error('Image payload survived');
        await new Promise(resolve => setTimeout(resolve, 15));
        runs[mode].push({ ipcMs: Math.round(elapsed), timerGapMs: Math.round(maxGap) });
      }
      clearInterval(timer);
    }
    return runs;
  }).toString() + ')()', true);
  const report = {
    electron: process.versions.electron, chrome: process.versions.chrome,
    identity: 'isolated Electron fixture, real ipcRenderer.invoke, no production app/profile',
    fixture: { entries: 500, toolImages: 29, base64CharsPerImage: 1024 * 1024 },
    // JSON size is a diagnostic proxy only, not actual serialized IPC bytes (aliases may be deduplicated).
    jsonBytes: { raw: JSON.stringify(raw).length, projected: JSON.stringify(projected).length },
    runs: results,
  };
  assert(report.jsonBytes.projected < report.jsonBytes.raw / 10, 'Projection must reduce fixture payload');
  console.log(JSON.stringify(report, null, 2));
  finish(0);
}).catch(error => { console.error(error); finish(1); });
setTimeout(() => { console.error('Electron IPC benchmark timed out'); finish(1); }, 45_000).unref();
