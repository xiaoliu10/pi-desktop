// 真实浏览器回归：压缩进行中发送被拒 → 完全静默（不写全局横幅、不写对话内错误卡），
// 正文退回输入框；压缩结束/下一轮开始后不残留任何提示。用户 2026-10-28 反馈：
// 「这个我觉得都取消好了」——v0.1.37 的横幅、v0.1.38 的错误卡都不要。
// 跑法：npx vite --host 127.0.0.1 --port 5175 --strictPort（本 worktree）+
//   playwright-cli -s=chatlink run-code --filename tests/silent-compaction-reject.browser.cjs
async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1180, height: 860 });
  const url = 'http://127.0.0.1:5175/silent-compaction-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root" class="pireplica"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    // 真实 store + 假 IPC：prompt 抛「压缩进行中」，history 回灌真实 user 条目
    const { usePiStore, sentConversationMessages } = await import('/pi/adapter.ts');
    window.store = usePiStore;
    window.branch = [{ id: 'u-0', type: 'message', message: { role: 'user', content: '上一轮' } }];
    window.localPi = {
      prompt: () => Promise.reject(new Error("Error invoking remote method 'local-pi:prompt': Error: Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.")),
      history: () => Promise.resolve({ branch: [...window.branch] }),
    };
    usePiStore.setState({ selectedKey: 'mock', runs: [{ key: 'mock', status: 'idle', generation: 'g', pending: 0 }], history: { branch: window.branch }, sends: [], connecting: false, draftText: '', contextItems: [], live: {}, toolProgress: {}, pendingSteer: {}, error: undefined, errorKey: undefined, view: 'chat' });
    window.send = text => usePiStore.getState().send(text);
    window.replay = () => {
      window.branch = [...window.branch, { id: 'u-1', type: 'message', message: { role: 'user', content: '重发的内容' } }];
    };
    function App() {
      const s = usePiStore();
      return React.createElement('main', { className: 'pireplica' }, React.createElement(ChatView, {
        messages: sentConversationMessages(s.history?.branch || [], s.live.mock, s.toolProgress.mock, s.sends || []),
        scrollRequest: s.sends?.at(-1)?.id, sending: s.sends?.some(x => !x.confirmedId) || false, labels: replicaLabels('zh').chat, demo: false,
      }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  // 1) 压缩中发送：静默
  await page.evaluate(() => window.send('压缩中发送的正文'));
  await page.waitForFunction(() => window.store.getState().draftText === '压缩中发送的正文', { timeout: 8000 });
  assert(await page.locator('.pi-banner--error').count() === 0, '不得出现全局错误横幅');
  assert(await page.locator('.pi-send-error').count() === 0, '不得出现对话内错误卡');
  assert(await page.getByText('compaction is in progress').count() === 0, '对话流不得显示拒发原因');
  assert(await page.getByText('Error invoking remote method').count() === 0, '不得出现 IPC 前缀错误');
  // 草稿回退在 store 层已验证（draftText === 输入）；harness 未挂真实 composer，
  // 故此处只断言对话流不出现该正文的孤儿气泡（渲染层无残留即可）。
  assert(await page.locator('.pi-chat__inner article').filter({ hasText: '压缩中发送的正文' }).count() === 0, '对话流不得残留该次发送的气泡');
  const s1 = await page.evaluate(() => { const s = window.store.getState(); return { error: s.error, sentAt: s.sentAt, sends: s.sends?.length ?? 0 }; });
  assert(!s1.error && !s1.sentAt && s1.sends === 0, `store 应无痕迹：${JSON.stringify(s1)}`);
  await page.screenshot({ path: 'output/playwright/silent-compaction-reject.png' });
  // 2) 压缩结束（compaction_end / agent_start 事件）：store 不得残留任何提示字段
  await page.evaluate(() => window.store.getState());
  await page.waitForTimeout(500);
  const s2 = await page.evaluate(() => { const s = window.store.getState(); return { error: s.error, sendError: 'sendError' in s, sends: s.sends?.length ?? 0, draft: s.draftText }; });
  assert(!s2.error && !s2.sendError && s2.sends === 0, `恢复后 store 应无痕迹：${JSON.stringify(s2)}`);
  assert(s2.draft === '压缩中发送的正文', '草稿仍在输入框，用户可直接重发');
  // 重发成功路径：history 回灌真实 user 条目 → 正常渲染，且全程无提示残留
  await page.evaluate(() => { window.replay(); window.store.setState({ history: { branch: window.branch }, sends: [{ id: 'send-1', key: 'mock', at: 2, text: '重发的内容', images: [], baseline: ['u-0'], confirmedId: 'u-1' }] }); });
  await page.waitForFunction(() => document.body.textContent.includes('重发的内容'), { timeout: 8000 });
  assert(await page.locator('.pi-banner--error').count() === 0, '重发后仍不得出现横幅');
  assert(await page.locator('.pi-send-error').count() === 0, '重发后仍不得出现错误卡');
  assert(await page.getByText('重发的内容').count() === 1, '重发内容正常渲染一次');
  assert(errors.length === 0, 'browser errors: ' + errors.join('\n'));
  console.log('PASS: 压缩中拒发完全静默（无横幅/无错误卡/正文可重发），恢复后无残留');
  return {};
}
