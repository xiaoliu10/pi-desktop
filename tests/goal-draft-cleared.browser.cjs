// 真实浏览器回归：扩展命令 disposition='handled' 有两种来源。
// ① /plan 这类无参 toggle：命令吞掉文字且不产生回合 → 文字退回输入框（既有行为保留）。
// ② /goal（pi-goal-x）：命令自己 sendUserMessage 启动回合，agent_start 先于 handled 应答到达
//    → 输入框必须保持为空；原文退回就是「goal 发出去了，输入框里还留着」（用户 2026-11-28 截图实报）。
// 跑法：npx vite --host 127.0.0.1 --port 5175 --strictPort（本 worktree）+
//   playwright-cli -s=goalclear run-code --filename tests/goal-draft-cleared.browser.cjs
async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1180, height: 860 });
  const url = 'http://127.0.0.1:5175/goal-draft-cleared';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    await import('/pi/replica-app.css'); await import('/replica/chat/chat.css');
    const { usePiStore } = await import('/pi/adapter.ts');
    const { Composer } = await import('/replica/chat/ChatView.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    window.store = usePiStore;
    let emit = null;
    // 每次发送由测试脚本决定：'handled' 前是否先投递 agent_start（模拟 /goal 的 sendUserMessage）。
    window.turnBeforeHandled = false;
    window.localPi = {
      onEvent: (fn) => { emit = fn; },
      prompt: () => {
        if (window.turnBeforeHandled) emit({ type: 'rpc', key: 'mock', generation: 'g', event: { type: 'agent_start' } });
        return Promise.resolve('handled');
      },
      history: () => Promise.resolve({ branch: [] }),
      runs: () => Promise.resolve([]), sessions: () => Promise.resolve([]), archivedSessions: () => Promise.resolve([]), recoverSubagents: () => Promise.resolve({ unchanged: true }),
      settingsSnapshot: () => Promise.reject('mock'), environment: () => Promise.reject('mock'),
    };
    usePiStore.setState({ selectedKey: 'mock', runs: [{ key: 'mock', status: 'idle', generation: 'g', pending: 0 }], history: { branch: [] }, sends: [], connecting: false, changingAccessMode: false, draftText: '', contextItems: [], live: {}, toolProgress: {}, pendingSteer: {}, error: undefined, errorKey: undefined, view: 'chat', notifications: [] });
    usePiStore.getState().init();
    await new Promise(r => setTimeout(r, 0));
    const labels = replicaLabels('zh');
    function App() {
      const s = usePiStore();
      return React.createElement('main', { className: 'pireplica', style: { height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } },
        React.createElement(Composer, {
          // 与 PiReplicaApp 的生产用法同构（见 src/renderer/pi/PiReplicaApp.tsx 的 <Composer …/>）。
          draftText: s.draftText, draftOwnerKey: 'mock',
          onDraftChange: text => usePiStore.setState({ draftText: text }),
          preparing: false, hasAttachments: false, sessionActive: true, demo: false,
          modelId: 'mock/model', modelGroups: [{ provider: 'mock', models: [{ id: 'mock/model', name: 'Mock' }] }],
          files: [], slashCommands: [], labels: labels.composer,
          reasoning: 'off', agentMode: 'agent', permissionMode: 'ask',
          running: false, sending: false, queued: 0,
          onSend: text => usePiStore.getState().send(text),
          onStop: () => {}, onPickModel: () => {}, onPickReasoning: () => {}, onPickAgentMode: () => {}, onPickPermission: () => {},
          onRefreshModels: () => {}, onQueueNow: () => {}, onQueueRecall: () => {}, onQueueRemove: () => {}, onImageGenerate: () => {}, onPickImageModel: () => {},
        }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const input = page.locator('textarea.pi-composer__input');
  await input.waitFor({ timeout: 8000 });
  const GOAL = '/goal 完善 AQA 自动量化交易工作台，让我能在对话中提交自己的策略脚本，或描述交易思路让 AQA 编写脚本';

  // ② /goal：命令自己启动回合 → 发送后输入框保持为空，且没有「文字已退回输入框」提示
  await page.evaluate(() => { window.turnBeforeHandled = true; });
  await input.fill(GOAL);
  assert((await input.inputValue()) === GOAL, '前置：输入框应有 /goal 原文');
  await page.waitForTimeout(400); // Composer 草稿 200ms 防抖后才写回 store；发送读 store
  await input.press('Enter'); // 与截图路径一致：回车发送
  await page.waitForTimeout(250); // 越过草稿防抖窗口，确认没有延迟退回
  assert(await page.evaluate(() => window.store.getState().draftText === ''), `/goal 发送后 store 草稿应保持为空，实际：${JSON.stringify((await page.evaluate(() => window.store.getState().draftText)))}`);
  assert((await input.inputValue()) === '', `/goal 发送后输入框应清空，实际残留：${JSON.stringify(await input.inputValue())}`);
  assert(await page.evaluate(() => !window.store.getState().notifications.some(n => (n.title || '').includes('文字已退回输入框'))), '/goal 不应提示「文字已退回输入框」');

  // ① /plan：命令吞掉文字、不产生回合 → 既有行为保留：文字退回 + 提示
  // 前提是会话空闲：上一步 /goal 启动的回合仍在进行，先把它收口。
  await page.evaluate(() => { window.turnBeforeHandled = false; window.store.setState({ runs: [{ key: 'mock', status: 'idle', generation: 'g', pending: 0 }], sends: [], sentAt: undefined, pendingPrompt: undefined, pendingPromptAt: undefined, notifications: [] }); });
  const PLAN = '/plan 把配置页面都改到左下角齿轮';
  await input.fill(PLAN);
  await page.waitForTimeout(400);
  await input.press('Enter');
  await page.waitForFunction(expected => document.querySelector('textarea.pi-composer__input').value === expected, PLAN, { timeout: 5000 });
  assert(await page.evaluate(() => window.store.getState().draftText) === PLAN, '/plan 的 store 草稿应退回原文');
  assert(await page.evaluate(() => window.store.getState().notifications.some(n => (n.title || '').includes('文字已退回输入框'))), '/plan 应提示「文字已退回输入框」');

  assert(errors.length === 0, 'browser errors: ' + errors.join('\n'));
  console.log('PASS: /goal 发送后输入框清空；/plan 仍退回文字');
  return {};
}
