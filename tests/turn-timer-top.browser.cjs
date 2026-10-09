// 回归：运行中的轮次，计时/转圈钉在本轮最顶部（不随最后段 kind 下移）；完成后恢复折叠组计时。
// 背景：#72 后结论文本会插在过程之间形成 [steps,text,steps]，此前计时绑尾段随之下移（用户截图）。
// Vite at :5175; playwright-cli run-code --filename tests/turn-timer-top.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1080, height: 860 });
  await page.addInitScript(() => { try { localStorage.setItem('pi-automation-tab', 'tasks'); } catch { /* 无关 */ } });
  await page.route('http://127.0.0.1:5175/timer-top', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/timer-top');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { historyToMessages } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css');
    await import('/replica/chat/chat.css');
    const branch = [
      { id: 'tt-u1', type: 'message', timestamp: '2026-10-09T00:00:00Z', message: { role: 'user', content: '继续任务' } },
      { id: 'tt-a1', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:10Z', content: [{ type: 'thinking', thinking: '先查看现状。' }, { type: 'toolCall', id: 'tt-c1', name: 'bash', arguments: { command: 'ls' } }] } },
      { id: 'tt-r1', type: 'message', message: { role: 'toolResult', toolCallId: 'tt-c1', toolName: 'bash', content: 'a.ts\nb.ts' } },
      { id: 'tt-a2', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:30Z', content: [{ type: 'text', text: '中间叙述：文件已确认，继续统计行数。' }] } },
      { id: 'tt-a3', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:40Z', content: [{ type: 'toolCall', id: 'tt-c2', name: 'bash', arguments: { command: 'wc -l *.ts' } }] } },
      { id: 'tt-r2', type: 'message', message: { role: 'toolResult', toolCallId: 'tt-c2', toolName: 'bash', content: '120 a.ts' } },
    ];
    const labels = { you: '你', assistant: 'pi', simulatedRun: '演示', toolRunning: '运行中', toolDone: '完成', toolError: '失败', details: '详情', queued: '排队', working: '执行中' };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('div', { className: 'pireplica', style: { padding: 16 } },
      React.createElement(ChatView, { messages: historyToMessages(branch), running: true, queued: 0, demo: false, labels, onJumpToMessage: () => {} })));
  });
  await page.locator('.pi-msg__runninghead').waitFor({ timeout: 15000 });
  const state = await page.evaluate(() => {
    const head = document.querySelector('.pi-msg__runninghead');
    const article = document.querySelector('.pi-msg--assistant');
    const firstDetails = article?.querySelector('details');
    const heads = document.querySelectorAll('.pi-msg__runninghead').length;
    const worked = document.body.textContent.match(/已工作/g)?.length ?? 0;
    const summaryTexts = [...article.querySelectorAll('summary.pi-execution__summary')].map(s => s.textContent.replace(/\s+/g, ' ').trim());
    return {
      heads,
      headBeforeDetails: !!head && !!firstDetails && (head.compareDocumentPosition(firstDetails) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      headHasTimer: !!head?.querySelector('.pi-execution__elapsed'),
      workedCount: worked,
      groupSummaryHasWorking: summaryTexts.some(t => t.includes('正在工作')),
      groupSummaries: summaryTexts,
    };
  });
  assert(state.heads === 1, '唯一顶部运行头，实际 ' + state.heads);
  assert(state.headBeforeDetails, '运行头在本轮所有过程内容之前');
  assert(state.headHasTimer, '运行头带计时');
  assert(state.workedCount === 1, '全文仅一处「已工作」计时，实际 ' + state.workedCount);
  assert(!state.groupSummaryHasWorking, '组头不重复「正在工作」');
  await page.screenshot({ path: '/Users/jason/projects/opensource/pi-desktop/output/playwright/turn-timer-top.png', fullPage: true });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS turn-timer-top: single running head pinned above all turn content; group headers yield';
}
