// 切换会话贴底：ChatView keep-alive 同实例下 conversationKey 变化必须重置跟随状态并贴底。
// 复现用户报告：切换会话后每次都停在最早位置，要手动点「回到最新」。
// Vite at :5175 (bind 127.0.0.1): npx vite --port 5175 --host 127.0.0.1
// playwright-cli -s chat-scroll open about:blank; run-code --filename tests/chat-scroll-bottom.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.route('http://127.0.0.1:5175/chat-scroll-bottom', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/chat-scroll-bottom');
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
    // 长会话：100 条用户消息（超过 TAIL_WINDOW=60，模拟真实会话规模）
    const long = Array.from({ length: 300 }, (_, i) => msg(`u-${i}`, 'user', `消息 ${i}\n${'内容行。'.repeat(30)}`));
    const other = Array.from({ length: 150 }, (_, i) => msg(`v-${i}`, 'user', `另一会话 ${i}\n${'不同内容。'.repeat(30)}`));
    const short = [msg('a', 'user', '短会话第一条'), msg('b', 'user', '短会话第二条')];
    window.__conversations = { long, other, short };
    window.render = (conversationKey, messages) => {
      createRoot(document.getElementById('root')).render(React.createElement('div', { className: 'pireplica', style: { display: 'flex', flexDirection: 'column', height: '100vh', minHeight: 0 } }, React.createElement(ChatView, {
        messages, conversationKey, running: false, queued: 0, demo: false,
        labels: { you: '你', assistant: '助手', working: '工作中', queued: '排队', jumpToMessage: '跳转' },
        onJumpToMessage() {}, onOpenToolFile() {}, onEditUserMessage() {}, onDownloadImage() {}, onRefreshProcess() {},
      })));
    };
  });
  const scroll = () => page.evaluate(() => { const el = document.querySelector('.pi-chat__scroll'); return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 8 }; });
  // 1) 首开即贴底
  await page.evaluate(() => render('session-1', window.__conversations.long));
  await page.waitForFunction(() => document.querySelectorAll('[data-msg]').length > 0, undefined, { timeout: 5000 });
  await page.waitForTimeout(300);
  let s1 = await scroll();
  assert(s1.atBottom, `first open sticks to the bottom (top=${s1.top} height=${s1.height})`);
  // 2) 用户滚到顶部（following=false，跳转按钮出现）
  await page.evaluate(() => { const el = document.querySelector('.pi-chat__scroll'); el.scrollTop = 0; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })); });
  await page.waitForTimeout(200);
  assert(await page.locator('.pi-chat__jumpbottom').count() === 1, 'scroll-up reveals the jump button');
  // 3) 切到另一个会话（仍是同实例、消息整体替换）→ 必须贴底，且跳转按钮消失
  await page.evaluate(() => render('session-2', window.__conversations.other));
  // tail window 只渲染尾部 60 条：会话 2 首条可见消息是 u-240（不是 u-0），跳转按钮必须消失
  await page.waitForFunction(() => document.querySelectorAll('[data-msg]')[0]?.dataset.msg === 'v-90' && document.querySelector('.pi-chat__jumpbottom') === null, undefined, { timeout: 5000 });
  await page.waitForTimeout(300);
  let s2 = await scroll();
  assert(s2.atBottom, `switching sessions sticks to the bottom (top=${s2.top} height=${s2.height})`);
  // 4) 切到短会话同样贴底
  await page.evaluate(() => render('session-3', window.__conversations.short));
  await page.waitForTimeout(300);
  assert((await scroll()).atBottom, 'switching to a shorter session also sticks to the bottom');
  // 5) 同 key 重渲染（history 刷新）不破坏跟随
  await page.evaluate(() => render('session-1', window.__conversations.long));
  await page.waitForTimeout(300);
  assert((await scroll()).atBottom, 're-render with the same key stays at the bottom');
  // 6) 异步到达（真实场景）：history IPC 先返回空、随后全量渲染——旧逻辑下 following=false
  //    导致全量渲染后停在顶部；修复后 key effect 已重置跟随，全量到达即贴底。
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
