// 真实浏览器回归：压缩进行中发送被拒 → 错误进对话流（不是全局横幅）→ 压缩结束自动消失。
// 跑法：npx vite --host 127.0.0.1 --port 5175 --strictPort（本 worktree）+ 
//   playwright-cli -s=chatlink run-code --filename tests/inline-send-error.browser.cjs
async (page) => {
  await page.setViewportSize({ width: 1180, height: 860 });
  const url = 'http://127.0.0.1:5175/inline-send-error-harness';
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
    // Vite root 是 src/renderer，共享模块走 vite 别名解析后的 URL
    // 分类器不单独 import：浏览器 harness 内的裸模块说明符不会被 vite transform。
    // 用它对真实文案的判定结果做断言（ChatView 内部就是这么分类的）。
    const isTransientSendError = (m) => /compaction is in progress/i.test(m);
    const COMPACTING = "Error invoking remote method 'local-pi:prompt': Error: Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";
    if (!isTransientSendError(COMPACTING)) throw Error('分类器未识别压缩中拒发');
    if (isTransientSendError('pi 已退出 (SIGKILL)。')) throw Error('分类器把真实失败误判为临时');
    const state = { sendError: { key: 'k-1', message: COMPACTING, at: 1 } };
    const root = createRoot(document.getElementById('root'));
    const render = () => root.render(React.createElement(ChatView, {
      messages: [], demo: false, labels: replicaLabels('zh').chat, onJumpToMessage: () => {},
      sendError: state.sendError, onDismissSendError: () => { state.sendError = undefined; render(); },
    }));
    window.__setState = (next) => { state.sendError = next; render(); };
    render();
  });
  await page.waitForSelector('.pi-send-error', { timeout: 15000 });
  const card = page.locator('.pi-send-error');
  if (await card.count() !== 1) throw Error('错误卡未出现在对话流');
  if (await page.locator('.pi-banner--error').count() !== 0) throw Error('仍走了全局错误横幅');
  const text = await card.innerText();
  if (!text.includes('compaction is in progress')) throw Error(`错误卡未显示原因：${text}`);
  if (text.includes('Error invoking remote method')) throw Error('错误卡仍带着 IPC 前缀');
  if (!text.includes('压缩完成后会自动消失')) throw Error(`错误卡缺少自动消失说明：${text}`);
  // 恢复：store 清空 sendError（compaction_end 等价）→ 卡片消失
  await page.evaluate(() => window.__setState(undefined));
  await page.waitForFunction(() => document.querySelectorAll('.pi-send-error').length === 0, { timeout: 5000 });
  // 再出现一次，验证手动关闭按钮
  await page.evaluate(() => window.__setState({ key: 'k-1', message: 'Cannot submit a prompt while compaction is in progress.', at: 2 }));
  await page.waitForSelector('.pi-send-error', { timeout: 5000 });
  await page.locator('.pi-send-error > button').click();
  await page.waitForFunction(() => document.querySelectorAll('.pi-send-error').length === 0, { timeout: 5000 });
  console.log('PASS: 压缩中拒发 → 对话内错误卡，恢复/关闭后消失，全局横幅未参与');
  return {};
}
