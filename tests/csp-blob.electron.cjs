// 真实 Electron 验证：index.html 里的 CSP 必须同时满足
//   1) blob: 图片能显示（img-src blob:）
//   2) 灯箱下载的 fetch(blob:) / XHR 不被拦（connect-src blob:）
// Node/vitest 只跑字符串断言；CSP 是浏览器行为，必须在 Chromium 里取证。
// 运行：npm run smoke:csp-blob（ELECTRON_RUN_AS_NODE 必须取消设置）。
const assert = require('node:assert/strict');
assert(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE, 'Run in Electron with ELECTRON_RUN_AS_NODE unset');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const csp = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1];
assert(csp, 'index.html must declare a CSP meta tag');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-blob-'));
app.setPath('userData', scratch);
let win;
let settled = false;
// 全局看门狗：loadFile/executeJavaScript 在 CI 里可能挂起（GPU 初始化等），
// 不能让 smoke 无限悬挂——参照 tests/settings-native-smoke.cjs 的先例。
const watchdog = setTimeout(() => fail('global watchdog: probe did not finish within 60s'), 60_000);
watchdog.unref?.();
const fail = (message) => { console.error('FAIL:', message); finish(1); };
const finish = (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(watchdog);
  win?.destroy();
  fs.rmSync(scratch, { recursive: true, force: true });
  // app.exit 立即以指定码退出；app.quit 会抢在 process.exitCode 生效前以 0 收场，
  // 让失败 smoke 在 CI 里假绿。
  app.exit(code);
};

app.whenReady().then(async () => {
  const probe = path.join(scratch, 'probe.html');
  fs.writeFileSync(probe, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><body></body>`);
  win = new BrowserWindow({ show: false, webPreferences: { webSecurity: true, sandbox: true } });
  const violations = [];
  win.webContents.on('console-message', (_e, _level, message) => {
    if (/Refused|violates the following Content Security Policy/i.test(message)) violations.push(message.split('\n')[0]);
  });
  await win.loadFile(probe);
  const out = await win.webContents.executeJavaScript(`(async () => {
    const results = {};
    // 合法 1x1 透明 PNG，避免损坏图片 onerror 干扰结论。
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    results.img = await new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve('ok');
      img.onerror = () => resolve('error');
      img.src = url;
      setTimeout(() => resolve('timeout'), 2000);
    });
    try { await (await fetch(url)).blob(); results.fetch = 'ok'; } catch { results.fetch = 'error'; }
    results.xhr = await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.onload = () => resolve('ok');
      xhr.onerror = () => resolve('error');
      xhr.send();
      setTimeout(() => resolve('timeout'), 2000);
    });
    return results;
  })()`, true);
  console.log('blob CSP probe:', JSON.stringify(out), 'violations:', violations.length);
  try {
    assert.deepEqual(out, { img: 'ok', fetch: 'ok', xhr: 'ok' }, 'blob image/fetch/xhr must all pass the CSP');
    assert.equal(violations.length, 0, 'no CSP violations expected: ' + violations.join(' | '));
    console.log('PASS: blob image display + download fetch both allowed by the shipped CSP');
    finish(0);
  } catch (error) { fail(error.message); }
}).catch(error => fail(error.stack || String(error)));
