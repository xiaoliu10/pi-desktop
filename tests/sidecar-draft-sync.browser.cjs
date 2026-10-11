// 同一 mainKey 的两个辅助对话面板实例（顶栏 + workbench 内嵌）草稿同步：
// localStorage 为唯一真理源。实例重新可见（IntersectionObserver 触发）或另一实例写入
//（手动派发 storage 事件）时以存储值重同步——keep-alive 实例绝不拿陈旧草稿覆盖新输入（review P1）。
// Vite at :5175 (bind 127.0.0.1): npx vite --port 5175 --host 127.0.0.1
// playwright-cli -s workbench run-code --filename tests/sidecar-draft-sync.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.route('http://127.0.0.1:5175/sidecar-draft-sync', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/sidecar-draft-sync');
  await page.evaluate(() => localStorage.removeItem('pi.sidecarDraft:main-1'));
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SidecarPanel } = await import('/pi/SidecarPanel.tsx');
    window.localPi = {
      sidecarBinding: async () => 'k1',
      sidecarEnsure: async () => ({ key: 'k1', run: { key: 'k1', generation: 'g', cwd: '/w', file: '/w/s.jsonl', status: 'idle', accessMode: 'ask', models: [], commands: [], pending: 0 } }),
      history: async () => ({ session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 1 }),
      onEvent: () => () => {}, prompt: async () => ({}), stop: async () => ({ steering: [], followUp: [] }), respond: async () => ({}),
    };
    for (const host of ['host-a', 'host-b']) {
      const el = document.createElement('div'); el.id = host; el.style.display = 'block'; document.body.appendChild(el);
      createRoot(el).render(React.createElement(SidecarPanel, { mainKey: 'main-1', autoStart: true, onClose() {} }));
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('.pi-sidecar textarea').length === 2, undefined, { timeout: 5000 });
  const boxes = page.locator('.pi-sidecar textarea');
  // 实例 A 输入（onChange 写存储 + 派发 storage）
  await boxes.nth(0).fill('草稿第一版');
  assert(await page.evaluate(() => localStorage.getItem('pi.sidecarDraft:main-1')) === '草稿第一版', 'typing persists the draft immediately');
  // 实例 B 收到 storage 事件同步（同页手动派发），随后 B 的输入成为最新值
  await page.waitForFunction(() => document.querySelectorAll('.pi-sidecar textarea')[1].value === '草稿第一版', undefined, { timeout: 5000 });
  await boxes.nth(1).fill('草稿第二版');
  assert(await page.evaluate(() => localStorage.getItem('pi.sidecarDraft:main-1')) === '草稿第二版', 'latest typing wins storage');
  // 实例 A 重新可见（IntersectionObserver 触发 resync）→ 以存储值重同步，绝不回退到陈旧本地值
  await page.evaluate(() => {
    const a = document.getElementById('host-a');
    a.style.display = 'none';
    void a.offsetWidth;
    a.style.display = 'block';
  });
  await page.waitForFunction(() => document.querySelectorAll('.pi-sidecar textarea')[0].value === '草稿第二版', undefined, { timeout: 5000 });
  assert(await page.evaluate(() => localStorage.getItem('pi.sidecarDraft:main-1')) === '草稿第二版', 'storage keeps the latest draft');
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS sidecar-draft-sync: storage is the source of truth; resync on storage event and re-visibility, never clobbers newer input';
}
