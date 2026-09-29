// Isolated Electron window: fixture-only APIs, temporary userData, no production configuration.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-settings-native-'));
app.setPath('userData', temp);
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, titleBarStyle: 'hiddenInset', show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('renderer:', message); });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(`http://127.0.0.1:5175/@fs${path.resolve('tests/fixtures/settings-native.html')}`);
    for (let i = 0; i < 80; i++) {
      if (await js('!!document.querySelector(".pi-sidebar")')) break;
      await sleep(100);
    }
    await js(`(async()=>{ const {usePiStore}=await import('/pi/PiReplicaApp.tsx'); const {DEFAULT_SHORTCUTS}=await import('/@fs${path.resolve('src/shared/settings.ts')}'); window.__testStore=usePiStore; const original=window.localPi.settingsSnapshot; window.localPi.settingsSnapshot=async()=>{const s=await original();return {...s,preferences:{...s.preferences,shortcuts:DEFAULT_SHORTCUTS}}}; usePiStore.setState({desktopPreferences:{...usePiStore.getState().desktopPreferences,shortcuts:DEFAULT_SHORTCUTS}}); usePiStore.getState().openSettings('general'); })()`);
    let checks = 0;
    for (const width of [1280, 860]) for (const scale of [0.85, 1, 1.25]) {
      win.setSize(width, 900); win.webContents.setZoomFactor(scale); await sleep(150);
      for (const label of ['快捷键', '语音输入']) {
        const data = await js(`(()=>{const e=[...document.querySelectorAll('.pi-settings__navitem')].find(e=>e.textContent.trim()===${JSON.stringify(label)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,drag:getComputedStyle(e).getPropertyValue('-webkit-app-region'),hidden:getComputedStyle(document.querySelector('.pi-sidebar')).display};})()`);
        assert.equal(data.drag, 'no-drag'); assert.equal(data.hidden, 'none');
        const x = Math.round(data.x * scale), y = Math.round(data.y * scale);
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x, y, clickCount: 1 });
        await sleep(200);
        const state = await js(`({page:window.__testStore.getState().settingsPage, label:document.querySelector('.pi-settings__navitem[aria-current="page"]')?.textContent})`);
        assert.equal(state.page, label === '快捷键' ? 'shortcuts' : 'voice', JSON.stringify({ width, scale, data, state }));
        checks++;
      }
    }
    win.webContents.setZoomFactor(1); win.setSize(1280, 900); await sleep(150);
    fs.mkdirSync('output/playwright', { recursive: true });
    fs.writeFileSync('output/playwright/settings-native-after.png', (await win.webContents.capturePage()).toPNG());
    const errors = await js('window.__fixtureErrors || []');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, errors, temp, method: 'Electron hiddenInset window + webContents.sendInputEvent' }));
    win.destroy(); app.exit(0);
  } catch (e) { console.error(e); win.destroy(); app.exit(1); }
});
setTimeout(() => { console.error('native smoke timeout'); app.exit(1); }, 90000).unref();
