// Run: playwright-cli -s=send-regression run-code --filename tests/pi-send-boundaries.browser.cjs
// Requires Vite on 127.0.0.1:5175. Synthetic data only; no Electron or user files.
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.route('http://127.0.0.1:5175/send-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/send-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    const { usePiStore, sentConversationMessages } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const style = document.createElement('style'); style.textContent = 'body{margin:0}.pireplica{height:100vh;display:flex;flex-direction:column}.pi-chat{flex:1;min-height:0}'; document.head.appendChild(style);
    window.store = usePiStore;
    window.mock = { prompts: [], histories: [] };
    window.localPi = {
      prompt: (...args) => new Promise((resolve, reject) => window.mock.prompts.push({ args, resolve, reject })),
      history: () => new Promise(resolve => window.mock.histories.push(resolve)),
    };
    window.branch = Array.from({ length: 30 }, (_, i) => ({ id: 'old-' + i, type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: '历史消息 ' + i + '\n\n' + '用于滚动验证。'.repeat(35) } }));
    usePiStore.setState({ selectedKey: 'mock', runs: [{ key: 'mock', status: 'idle', generation: 'g', pending: 0 }], history: { branch: window.branch }, sends: [], connecting: false, draftText: '', contextItems: [], live: {}, toolProgress: { mock: [{ toolCallId: 'old-tool', name: 'bash', text: 'OLD_TOOL_RESULT', status: 'done' }] } });
    window.send = text => usePiStore.getState().send(text);
    function App() {
      const s = usePiStore(); const sends = s.sends || [];
      return React.createElement('main', { className: 'pireplica' }, React.createElement(ChatView, {
        messages: sentConversationMessages(s.history?.branch || [], s.live.mock, s.toolProgress.mock, sends),
        scrollRequest: sends.at(-1)?.id, sending: sends.some(s => !s.confirmedId), labels: replicaLabels('zh').chat, demo: false,
      }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  const scroll = page.locator('.pi-chat__scroll'); await scroll.waitFor();
  const bottom = () => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 5);
  const lastUser = () => page.locator('.pi-chat__inner > article').last().getAttribute('class');
  for (let round = 1; round <= 2; round++) {
    await scroll.hover(); await page.mouse.wheel(0, -1600);
    // wheel() returns before Chromium dispatches the scroll; let this gesture finish before Send.
    await page.waitForTimeout(250);
    await page.waitForFunction(() => { const el = document.querySelector('.pi-chat__scroll'); return el.scrollHeight - el.clientHeight - el.scrollTop > 300; });
    await page.evaluate(n => window.send('新消息-' + n), round);
    await page.getByText('新消息-' + round, { exact: true }).waitFor();
    assert((await lastUser()).includes('pi-msg--user'), `round ${round}: new user last before IPC`);
    await page.waitForFunction(() => { const el = document.querySelector('.pi-chat__scroll'); return el.scrollHeight - el.clientHeight - el.scrollTop < 5; });
    // Leave IPC unresolved for a full second. No old progress after the user.
    await page.waitForTimeout(1100);
    assert(await bottom(), `round ${round}: slow IPC stays bottom`);
    assert((await lastUser()).includes('pi-msg--user'), 'no trailing old work');
    await page.screenshot({ path: `output/playwright/send-round-${round}.png` });
    await page.evaluate(n => { window.mock.prompts[n - 1].resolve(); }, round);
    await page.waitForFunction(n => window.mock.histories.length >= n, round);
    await page.evaluate(n => {
      window.branch.push({ id: 'confirmed-' + n, type: 'message', message: { role: 'user', content: '新消息-' + n } });
      window.mock.histories[n - 1]({ branch: [...window.branch] });
    }, round);
    await page.waitForFunction(n => window.store.getState().sends.at(-1).confirmedId === 'confirmed-' + n, round);
    assert(await page.getByText('新消息-' + round, { exact: true }).count() === 1, 'no duplicate after ack');
    // Real wheel input pauses following; subsequent current-turn growth must not yank back.
    await scroll.hover(); await page.mouse.wheel(0, -1400);
    await page.waitForFunction(() => document.querySelector('.pi-chat__scroll').scrollHeight - document.querySelector('.pi-chat__scroll').clientHeight - document.querySelector('.pi-chat__scroll').scrollTop > 300);
    const top = await scroll.evaluate(el => el.scrollTop);
    await page.evaluate(n => {
      const s = window.store.getState(); const id = s.sends.at(-1).id;
      window.store.setState({ live: { mock: { ...s.live.mock, ['reply-' + n]: { role: 'assistant', _turnId: id, content: '本轮回复\n\n'.repeat(80) } } } });
    }, round);
    await page.waitForTimeout(300);
    assert(Math.abs(await scroll.evaluate(el => el.scrollTop) - top) < 5, 'manual scroll survives stream growth');
    assert(!await bottom(), 'manual scroll not forced bottom');
  }
  // Attachment-only send is visible immediately; rollback preserves attachment and scroll position.
  await page.evaluate(() => {
    window.store.setState({ contextItems: [{ id: 'img', name: 'pixel.png', path: '', text: '', kind: 'image', image: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } }] });
    window.send('');
  });
  await page.locator('.pi-chat__inner > article').last().locator('img').waitFor();
  assert(await bottom(), 'attachment forces bottom');
  await page.screenshot({ path: 'output/playwright/send-attachment.png' });
  await scroll.hover(); await page.mouse.wheel(0, -1000); await page.waitForTimeout(200);
  const top = await scroll.evaluate(el => el.scrollTop);
  await page.evaluate(() => window.mock.prompts[2].reject(new Error('synthetic offline')));
  await page.waitForFunction(() => window.store.getState().error === 'synthetic offline');
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => window.store.getState().contextItems.length === 1 && window.store.getState().sends.length === 2), 'attachment rollback');
  assert(Math.abs(await scroll.evaluate(el => el.scrollTop) - top) < 5, 'rollback does not replay old scroll request');
  // /skill 命令：pi 落盘的是展开后的 <skill>…</skill> + 原正文，不是原始输入。
  // 乐观气泡必须被认领撤场，否则对话区出现两条重复的用户消息（2026-10-28 用户实测）。
  // 附件轮回滚会把图片还原进 contextItems；skill 轮不带附件（真实场景即无附件），
  // 否则 confirmSends 的图片数量门（0≠1）会在 skill 匹配前把认领拒掉。
  await page.evaluate(() => window.store.setState({ contextItems: [] }));
  await page.evaluate(() => {
    window.setLog = [];
    window.store.subscribe((s) => {
      const last = s.sends?.at(-1);
      window.setLog.push({ h: s.history?.branch?.at(-1)?.id ?? null, c: last?.confirmedId ?? null, n: s.sends?.length });
    });
  });
  await page.evaluate(() => window.send('/skill:demo 自主工作问题'));
  await page.getByText('/skill:demo 自主工作问题', { exact: true }).waitFor();
  await page.evaluate(() => window.mock.prompts[window.mock.prompts.length - 1].resolve());
  // 附件轮的 prompt 被拒绝、不产生 history 请求，histories 与 prompts 数量天然错位：
  // 等本轮的 history resolver 出现后直接解决最后一个。
  try {
    await page.waitForFunction(() => window.mock.histories.length >= 3, { timeout: 8000 });
  } catch (e) {
    const dump = await page.evaluate(() => ({ histories: window.mock.histories.length, prompts: window.mock.prompts.length, sending: window.store.getState().sending, selected: window.store.getState().selectedKey, runs: window.store.getState().runs?.map(r => r.key) }));
    throw new Error('skill history resolver wait failed: ' + JSON.stringify(dump));
  }
  await page.evaluate(() => {
    window.branch.push({ id: 'skill-1', type: 'message', message: { role: 'user', content: '<skill name="demo" location="/skills/demo/SKILL.md">\n# Demo\n</skill>\n\n自主工作问题' } });
    // 可能存在多个待决 history 调用（promptDone 与其它触发背靠背）：全部灌入新 branch，
    // 过期调用由 refreshHistory 的 seq/generation 守卫丢弃，最新一次会完成确认。
    for (const resolve of window.mock.histories) resolve({ branch: [...window.branch] });
    window.mock.histories.length = 0;
  });
  // 确认前可能还会排入新的 history 请求（去抖合并）：持续把最新 branch 灌给所有待决
  // resolver，直到乐观气泡被认领；过期调用由 seq/generation 守卫自行丢弃。
  const waitSkillConfirm = async (timeout) => page.waitForFunction(() => window.store.getState().sends.at(-1).confirmedId === 'skill-1', { timeout });
  try {
    await waitSkillConfirm(8000);
  } catch (e) {
    let settled = false;
    for (let i = 0; i < 8 && !settled; i++) {
      const had = await page.evaluate(() => {
        if (!window.mock.histories.length) return false;
        for (const resolve of window.mock.histories) resolve({ branch: [...window.branch] });
        window.mock.histories.length = 0;
        return true;
      });
      if (!had) break;
      try { await waitSkillConfirm(3000); settled = true; } catch { }
    }
    if (!settled) {
      const dump = await page.evaluate(() => {
        const s = window.store.getState();
        let direct = null;
        try { direct = window.confirmSends(s.sends.map(x => ({ ...x })), s.history, 'mock').map(x => x.confirmedId); } catch (e) { direct = 'ERR ' + e.message; }
        return { storeBranchLast: s.history?.branch?.at(-1)?.id, storeBranchLen: s.history?.branch?.length, windowBranchLen: window.branch.length, direct, skillSend: JSON.parse(JSON.stringify(s.sends.at(-1))), setLog: window.setLog?.slice(-6) };
      });
      throw new Error('skill confirm wait failed: ' + JSON.stringify(dump));
    }
  }
  assert(await page.getByText('自主工作问题').count() === 1, 'skill send renders exactly once after ack');
  const chipCount = await page.getByText('技能 · demo').count();
  if (chipCount !== 1) {
    const dump = await page.evaluate(() => Array.from(document.querySelectorAll('.pi-chat__inner > article')).map(a => a.textContent.slice(0, 120)));
    throw new Error('skill chip count=' + chipCount + ' articles=' + JSON.stringify(dump));
  }
  await page.screenshot({ path: 'output/playwright/send-skill-dedupe.png' });
  await page.screenshot({ path: 'output/playwright/send-boundaries.png' });
  assert(errors.length === 0, 'browser errors: ' + errors.join('\n'));
  console.log('PASS: two slow IPC rounds, immediate last user, old tools before user, stable acknowledgement, wheel-up during growth, attachment-only and failure rollback');
}
