// 切换会话贴底：ChatView keep-alive 同实例下 conversationKey 变化必须重置跟随状态并贴底。
// 复现用户报告：在会话 A 滚到中部读历史 → 切到会话 B → B 停在旧滚动位置（不贴底）。
// 关键约束（review P1/P2）：root 必须复用（每次 createRoot 是全新实例，测不到 keep-alive）；
// 滚离后等 >1s（userScrollUntil 宽限）；滚动位置取 400px（>240 不触发顶部补载、位于列表内部）。
// Vite at :5175 (bind 127.0.0.1): npx vite --port 5175 --host 127.0.0.1
// playwright-cli -s chat-scroll open about:blank; run-code --filename tests/chat-scroll-bottom.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.route('http://127.0.0.1:5175/chat-scroll-bottom', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/chat-scroll-bottom');
  await page.evaluate(() => localStorage.removeItem('pi.sidecarDraft:main-1'));
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    await import('/replica/tokens.css');
    await import('/replica/chat/chat.css');
    // 直接构造 ChatMessage（sentConversationMessages 的输出形态），executionTurns 在 ChatView 内部生成 turns
    const msg = (id, role, text) => ({ id, role, parts: [{ kind: 'text', id, text }] });
    const long = Array.from({ length: 300 }, (_, i) => msg(`u-${i}`, 'user', `消息 ${i}\n${'内容行。'.repeat(30)}`));
    const other = Array.from({ length: 150 }, (_, i) => msg(`v-${i}`, 'user', `另一会话 ${i}\n${'不同内容。'.repeat(30)}`));
    const short = [msg('a', 'user', '短会话第一条'), msg('b', 'user', '短会话第二条')];
    window.__conversations = { long, other, short };
    // keep-alive 前提：root 只建一次复用；每次 render 前打 DOM 标记、渲染后断言标记存活（防桩退化为重挂载）
    window.__root ??= createRoot(document.getElementById('root'));
    window.render = (conversationKey, messages) => {
      const el = document.getElementById('root');
      el.dataset.keepAliveProbe = 'alive';
      window.__root.render(React.createElement('div', { className: 'pireplica', style: { display: 'flex', flexDirection: 'column', height: '100vh', minHeight: 0 } }, React.createElement(ChatView, {
        messages, conversationKey, running: false, queued: 0, demo: false,
        labels: { you: '你', assistant: '助手', working: '工作中', queued: '排队', jumpToMessage: '跳转' },
        onJumpToMessage() {}, onOpenToolFile() {}, onEditUserMessage() {}, onDownloadImage() {}, onRefreshProcess() {},
      })));
      if (el.dataset.keepAliveProbe !== 'alive') throw new Error('harness bug: render() remounted the tree — keep-alive no longer under test');
    };
  });
  const scroll = () => page.evaluate(() => { const el = document.querySelector('.pi-chat__scroll'); return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 8 }; });
  // 1) 首开即贴底
  await page.evaluate(() => render('session-1', window.__conversations.long));
  await page.waitForFunction(() => document.querySelectorAll('[data-msg]').length > 0, undefined, { timeout: 5000 });
  await page.waitForTimeout(300);
  let s1 = await scroll();
  assert(s1.atBottom, `first open sticks to the bottom (top=${s1.top} height=${s1.height})`);
  // 2) 用户滚到 400px（位于列表内部、不触发顶部补载）→ 跟随暂停、跳转按钮出现
  await page.evaluate(() => { const el = document.querySelector('.pi-chat__scroll'); el.scrollTop = 400; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })); });
  await page.waitForTimeout(200);
  assert(await page.locator('.pi-chat__jumpbottom').count() === 1, 'scroll-up reveals the jump button');
  // 等 userScrollUntil 的 1s 宽限过期（review P2：宽限内的 scroll 会按 nearBottom 自愈，掩盖 bug）
  await page.waitForTimeout(1100);
  // 3) 切到另一个会话（同实例、消息整体替换、内容不同）→ 必须贴底，且跳转按钮消失
  await page.evaluate(() => render('session-2', window.__conversations.other));
  // tail window 只渲染尾部：会话 2 首条可见消息是 v-90（150-60），跳转按钮必须消失
  await page.waitForFunction(() => document.querySelectorAll('[data-msg]')[0]?.dataset.msg === 'v-90' && document.querySelector('.pi-chat__jumpbottom') === null, undefined, { timeout: 5000 });
  await page.waitForTimeout(300);
  const s2 = await scroll();
  assert(s2.atBottom, `switching sessions sticks to the bottom (top=${s2.top} height=${s2.height})`);
  // 4) 切到短会话同样贴底
  await page.evaluate(() => render('session-3', window.__conversations.short));
  await page.waitForTimeout(300);
  assert((await scroll()).atBottom, 'switching to a shorter session also sticks to the bottom');
  // 5) 同 key 重渲染（history 刷新）不破坏跟随
  await page.evaluate(() => render('session-1', window.__conversations.long));
  await page.waitForTimeout(300);
  assert((await scroll()).atBottom, 're-render with the same key stays at the bottom');
  // 6) 异步到达（真实场景）：history IPC 先返回空、随后全量渲染——修复前 following=false
  //    导致全量渲染后停在旧滚动位置；修复后 key effect 已重置跟随，全量到达即贴底。
  await page.evaluate(() => render('session-4', []));
  await page.waitForTimeout(300);
  await page.evaluate(() => render('session-4', window.__conversations.other));
  await page.waitForTimeout(400);
  const asyncCase = await scroll();
  assert(asyncCase.atBottom, `async history arrival sticks to the bottom (top=${asyncCase.top} height=${asyncCase.height})`);
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await page.locator('.pi-chat__scroll').screenshot({ path: 'output/playwright/chat-scroll-bottom.png' });
  return 'PASS chat-scroll-bottom: switching sessions sticks to the newest message (following resets)';
}
