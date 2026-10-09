// 回归：运行中（1）过程叙述原位直接可见、不折进执行组；（2）点击第一个过程组头把整轮
// 工具/思考收成一条汇总，文本保持可见；再点汇总条恢复逐段渲染。
// 背景：#72 后 live 段 expanded 受控拉直，组头点不动且各组只折叠自己段（用户截图反馈）。
// Vite at :5175; playwright-cli run-code --filename tests/live-fold.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1080, height: 860 });
  await page.route('http://127.0.0.1:5175/live-fold', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/live-fold');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { historyToMessages } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css');
    await import('/replica/chat/chat.css');
    // [steps, text, steps, text, steps] 多段轮次：两段中间叙述 + 三组工具
    const branch = [
      { id: 'lf-u1', type: 'message', timestamp: '2026-10-09T00:00:00Z', message: { role: 'user', content: '继续任务' } },
      { id: 'lf-a1', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:10Z', content: [{ type: 'toolCall', id: 'lf-c1', name: 'bash', arguments: { command: 'node -v' } }] } },
      { id: 'lf-r1', type: 'message', message: { role: 'toolResult', toolCallId: 'lf-c1', toolName: 'bash', content: 'a.ts' } },
      { id: 'lf-a2', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:20Z', content: [{ type: 'text', text: '叙述一：文件已确认。' }] } },
      { id: 'lf-a3', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:30Z', content: [{ type: 'toolCall', id: 'lf-c2', name: 'bash', arguments: { command: 'pnpm -v' } }] } },
      { id: 'lf-r2', type: 'message', message: { role: 'toolResult', toolCallId: 'lf-c2', toolName: 'bash', content: '120' } },
      { id: 'lf-a4', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:40Z', content: [{ type: 'text', text: '叙述二：行数统计完成。' }] } },
      { id: 'lf-a5', type: 'message', message: { role: 'assistant', timestamp: '2026-10-09T00:00:50Z', content: [{ type: 'toolCall', id: 'lf-c3', name: 'bash', arguments: { command: 'git status --short' }, }] } },
      { id: 'lf-r3', type: 'message', message: { role: 'toolResult', toolCallId: 'lf-c3', toolName: 'bash', content: 'end' } },
    ];
    const labels = { you: '你', assistant: 'pi', simulatedRun: '演示', toolRunning: '运行中', toolDone: '完成', toolError: '失败', details: '详情', queued: '排队', working: '执行中' };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('div', { className: 'pireplica', style: { padding: 16 } },
      React.createElement(ChatView, { messages: historyToMessages(branch), running: true, queued: 0, demo: false, labels, onJumpToMessage: () => {} })));
  });
  await page.locator('.pi-msg__runninghead').waitFor({ timeout: 15000 });
  const expanded = await page.evaluate(() => {
    const article = document.querySelector('.pi-msg--assistant');
    return {
      details: article.querySelectorAll('details.pi-execution').length,
      commentary: document.body.textContent.includes('pi-execution__commentary') || article.querySelectorAll('.pi-execution__commentary').length,
      answers: [...article.querySelectorAll('.pi-msg__answer')].map(a => a.textContent.trim()).filter(Boolean),
      openCount: [...article.querySelectorAll('details.pi-execution')].filter(d => d.open).length,
    };
  });
  assert(expanded.details === 3, '运行中三段过程各自成组，实际 ' + expanded.details);
  assert(!expanded.commentary, '运行中叙述不折进组内段落（commentary 应为 0）');
  assert(expanded.answers.length === 2 && expanded.answers.some(t => t.includes('叙述一：')) && expanded.answers.some(t => t.includes('叙述二：')),
    '两段叙述按时间线原位直接可见，实际 ' + JSON.stringify(expanded.answers));
  assert(expanded.openCount === 3, '所有过程段保持展开，实际 ' + expanded.openCount);

  // 点击第一个组头 → 整轮收成一条汇总
  await page.locator('details.pi-execution').first().locator('summary.pi-execution__summary').click();
  await page.waitForFunction(() => document.querySelectorAll('details.pi-execution').length === 1);
  await page.waitForTimeout(400); // 等 React 过渡稳定（原生 toggle 与重渲染交错，避免断言中间态）
  const folded = await page.evaluate(() => {
    const article = document.querySelector('.pi-msg--assistant');
    const only = article.querySelector('details.pi-execution');
    const steps = only.querySelectorAll('.pi-execution__steps').length ? only.querySelectorAll('.pi-execution__steps > *').length : 0;
    return {
      details: article.querySelectorAll('details.pi-execution').length,
      open: only?.open,
      stepsTopLevel: steps,
      subgroupText: only.textContent.includes('终端 · 3 条命令'),
      narration: [...article.querySelectorAll('.pi-msg__answer')].map(a => a.textContent.trim()),
      head: !!article.querySelector('.pi-msg__runninghead'),
    };
  });
  assert(folded.details === 1, '折叠后只剩一条汇总组，实际 ' + folded.details);
  assert(!folded.open, '汇总组默认收起');
  assert(folded.subgroupText, '汇总组聚合整轮 3 个步骤（终端 · 3 条命令）');
  assert(folded.narration.length === 2, '折叠不藏叙述文本，实际 ' + JSON.stringify(folded.narration));
  assert(folded.head, '运行头保持顶部');
  await page.screenshot({ path: '/Users/jason/projects/opensource/pi-desktop/output/playwright/live-fold-collapsed.png', fullPage: true });

  // 点开汇总条 → 恢复逐段展开视图
  await page.locator('details.pi-execution').first().locator('summary.pi-execution__summary').click();
  await page.waitForFunction(() => document.querySelectorAll('details.pi-execution').length === 3);
  await page.waitForTimeout(400);
  const restored = await page.evaluate(() => {
    const article = document.querySelector('.pi-msg--assistant');
    return { details: article.querySelectorAll('details.pi-execution').length, open: [...article.querySelectorAll('details.pi-execution')].filter(d => d.open).length };
  });
  assert(restored.details === 3 && restored.open === 3, '恢复逐段展开视图，实际 ' + JSON.stringify(restored));
  await page.screenshot({ path: '/Users/jason/projects/opensource/pi-desktop/output/playwright/live-fold-expanded.png', fullPage: true });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS live-fold: narration stays visible in place; first group header folds whole turn; expanding summary restores segments';
}
