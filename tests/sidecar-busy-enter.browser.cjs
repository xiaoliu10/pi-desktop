// 副驾两个 review P1 的行为锁：
// P1-1 busy 时 Enter 不丢输入：Composer.submit 先清本地文本再调 onSend；SidecarPanel.send
//      的守卫（busy/sending/loading/dialog）若直接 return，输入就无痕消失。守护：守卫
//      拒绝时把权威文本回填 draft（Composer 经 draftText effect 同步回 localText）。
// P1-2 非 ask/非审批 dialog 有应答路径：主 UI 只渲染 selectedKey 的 dialog，副驾 key
//      永不等同——兜底卡（FallbackDialog）必须能 respond（取消/拒绝 + 文本提交）。
// Vite at :5175:
//   npx vite --port 5175 --host 127.0.0.1
//   playwright-cli -s sidecar open about:blank; run-code --filename tests/sidecar-busy-enter.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.route('http://127.0.0.1:5175/sidecar-busy', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/sidecar-busy');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    window.__errs = [];
    window.addEventListener('error', e => window.__errs.push(String(e.message).slice(0, 400)));
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SidecarPanel } = await import('/pi/SidecarPanel.tsx');
    const { usePiStore } = await import('/pi/adapter.ts');
    const prompts = []; const responds = [];
    // 副驾 run 常驻 running：busy 守卫生效（读输出时打字追问的场景）。
    const busyRun = { key: 'sc-1', generation: 'g1', cwd: '/w', file: '/w/sc.jsonl', status: 'running', models: [], commands: [], pending: 0 };
    window.localPi = {
      sidecarBinding: async () => 'sc-1',
      sidecarEnsure: async () => ({ key: 'sc-1', run: busyRun }),
      history: async () => ({ session: {}, entries: [], branch: [], leaves: [], leafId: null, syncedAt: 1 }),
      onEvent: () => () => {},
      prompt: async (key, text) => { prompts.push(text); return {}; },
      stop: async () => ({ steering: [], followUp: [] }),
      respond: async (key, gen, r) => { responds.push(r); return {}; },
    };
    window.__prompts = prompts;
    window.__responds = responds;
    usePiStore.setState({ runs: [busyRun], dialogs: [] });
    // 注入一个扩展 input dialog（非 ask 非审批）：验证兜底卡出现且可应答。
    // SidecarPanel 从 usePiStore.dialogs 读（d.key === sidecar key）。
    window.__pushDialog = () => usePiStore.setState({ dialogs: [{ key: 'sc-1', generation: 'g1', request: { id: 'req-x', method: 'input', title: '扩展提问', message: '请输入内容' } }] });
    createRoot(document.getElementById('root')).render(React.createElement(SidecarPanel, { mainKey: 'main-1', autoStart: true, onClose: () => {} }));
  });
  await page.waitForTimeout(600);

  // ── P1-1：busy 时打字 + Enter，输入不得消失 ──
  await page.evaluate(() => { const ta = document.querySelector('.pi-sidecar textarea'); if (!ta) throw new Error('composer textarea missing'); ta.focus(); });
  await page.keyboard.type('追问一句');
  await page.waitForTimeout(300); // 防抖回流后再提交（避免 200ms 内的 draft 竞态）
  const before = await page.evaluate(() => document.querySelector('.pi-sidecar textarea').value);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => document.querySelector('.pi-sidecar textarea').value);
  assert(kept.includes('追问一句'), `busy Enter 丢了输入：before=${JSON.stringify(before)} after=${JSON.stringify(kept)}`);
  assert(await page.evaluate(() => window.__prompts.length === 0), 'busy 时按 Enter 竟然发送了 prompt');

  // ── P1-2：扩展 input dialog 有兜底卡且可取消应答 ──
  await page.evaluate(() => window.__pushDialog());
  await page.waitForTimeout(400);
  const fb = await page.evaluate(() => {
    const card = document.querySelector('.pi-sidecar .pi-ask-inline');
    if (!card) return null;
    return { title: card.textContent.includes('扩展提问'), hasInput: !!card.querySelector('textarea'), buttons: [...card.querySelectorAll('button')].map(b => b.textContent) };
  });
  assert(fb && fb.title, '非 ask/审批 dialog 没有兜底卡');
  assert(fb.hasInput, 'input 类兜底卡没有文本框');
  assert(fb.buttons.some(t => t.includes('取消')), `兜底卡没有取消按钮：${JSON.stringify(fb.buttons)}`);
  await page.evaluate(() => { const btns = [...document.querySelectorAll('.pi-sidecar .pi-ask-inline button')]; const cancel = btns.find(b => b.textContent.includes('取消')); cancel.click(); });
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => window.__responds.length === 1 && window.__responds[0].cancelled === true),
    `兜底卡取消没有走到 respond：${JSON.stringify(await page.evaluate(() => window.__responds))}`);

  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}
