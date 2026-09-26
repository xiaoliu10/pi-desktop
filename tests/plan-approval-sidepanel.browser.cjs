// 计划审批：右侧自动展开计划全文（内容长，对话框位置展示不全）+ 对话框上方保留批准卡。
// 命令权限审批的内联卡已在 tests/extension-dialog-overflow.browser.cjs 覆盖。
// Vite at :5175; playwright-cli -s plan open about:blank; run-code --filename tests/plan-approval-sidepanel.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.route('http://127.0.0.1:5175/plan-side', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/plan-side');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    window.__errs = [];
    window.addEventListener('error', e => window.__errs.push(String(e.message).slice(0, 400)));
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const PiReplicaApp = (await import('/pi/PiReplicaApp.tsx')).default;
    const { usePiStore } = await import('/pi/adapter.ts');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css'); await import('/replica/shell/sidebar.css');
    await import('/replica/overlays/overlays.css'); await import('/pi/replica-app.css'); await import('/pi/settings-features.css');
    window.localPi = {
      settingsSnapshot: async () => ({ preferences: { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [] }, ai: {} }),
      environment: async () => ({ requestedRuntime: 'auto', customExecutable: '', agentDir: '/agents', sessionDirs: [] }),
      sessions: async () => [{ key: 'k1', id: 'k1', path: '/s/k1.jsonl', cwd: '/work/x', name: '计划会话', updatedAt: Date.now(), size: 10, warnings: [], owned: true }],
      runs: async () => [{ key: 'k1', generation: 'g1', cwd: '/work/x', file: '/s/k1.jsonl', status: 'idle', accessMode: 'plan', planReady: true, models: [], commands: [], pending: 0 }],
      archivedSessions: async () => [],
      onEvent: () => () => {},
      modelCatalog: async () => ({ providers: [], defaultProvider: null, defaultModel: null }),
      resources: async () => [],
      packageList: async () => ({ packages: [] }),
      history: async () => ({ leafId: 'm2', leaves: ['m2'], branch: [
        { id: 'm1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: '帮我规划并实施 X' }] } },
        { id: 'm2', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '# 实施计划\n\n## 步骤\n\n1. 先做 A\n2. 再做 B\n3. 最后做 C\n\n## 风险\n\n- 兼容性' }] } },
      ] }),
      projectFiles: async () => [], composerSkills: async () => [], pickDocuments: async () => [],
      resourceRead: async () => ({ text: '' }), projectContext: async () => ({}),
      voiceConfig: async () => ({ activeId: null, models: [] }), voiceTranscribe: async () => '',
      automationSnapshot: async () => ({ tasks: [] }), onAutomationChanged: () => () => {},
      pickDirectory: async () => null,
      externalApps: async () => [],
      // 其余渲染层可能用到的方法给安全兑底，避免无关崩溃干扰本用例
      projectBranch: async () => null, projectArchive: async () => null, projectReveal: async () => null,
      projectWorktree: async () => null, projectSave: async () => null, gitStatus: async () => null,
      memoryList: async () => [], memoryOpen: async () => null, memoryRead: async () => ({ text: '' }),
      memoryEnableDefault: async () => null, saveAiSettings: async () => null, modelDefaultSave: async () => null,
      modelProviderSave: async () => null, modelProviderRemove: async () => null,
      filePreview: async () => null, review: async () => null, refresh: async () => null, refreshEnvironment: async () => null,
      downloadImage: async () => null, revealPath: async () => null, openWith: async () => null,
      terminalCreate: async () => null, terminalKill: async () => null, terminalWrite: () => {}, terminalResize: () => {},
      onTerminalData: () => () => {}, onTerminalExit: () => () => {}, close: async () => null,
      accountStatus: async () => null, accountLogin: async () => null, accountAnswer: async () => null, accountCancel: async () => null,
      officialSubagentStatus: async () => null, enableOfficialSubagent: async () => null, recoverSubagents: async () => null,
      packageCovers: async () => null, packageSearch: async () => ({ packages: [] }), packageInstall: async () => null,
      packageRegister: async () => null, saveDesktopSettings: async () => null, configure: async () => null,
      setAccessMode: async () => null, connect: async () => null, model: async () => null, thinking: async () => null,
      prompt: async () => null, respond: async () => null, stop: async () => null, compact: async () => null,
      queueEdit: async () => null, forkMessage: async () => null, setSessionArchived: async () => false,
      deleteArchivedSession: async () => false, upgradeLocalPi: async () => null, importAttachments: async () => [],
      clipboardAttachments: async () => [], voiceSaveModel: async () => null, voiceRemoveModel: async () => null, voiceSetActive: async () => null,
    };
    window.store = usePiStore;
    createRoot(document.getElementById('root')).render(React.createElement(PiReplicaApp));
  });
  await page.waitForTimeout(400); // init 异步落地
  await page.evaluate(() => window.store.getState().selectSession('k1'));
  try {
    await page.locator('.pi-plan-approval').waitFor({ timeout: 5000 });
  } catch (e) {
    const diag = await page.evaluate(() => JSON.stringify({ errs: window.__errs || [], rootLen: document.getElementById('root').innerHTML.length }));
    throw new Error('plan approval card missing: ' + diag);
  }
  // 右侧计划面板自动展开，展示计划全文（无需点击「查看全文」）
  await page.locator('.pi-plan-viewer').waitFor({ timeout: 5000 });
  const viewerText = await page.locator('.pi-plan-viewer').innerText();
  assert(viewerText.includes('实施计划'), 'plan viewer should show plan title');
  assert(viewerText.includes('再做 B'), 'plan viewer should show plan body');
  const approvalText = await page.locator('.pi-plan-approval').innerText();
  assert(approvalText.includes('批准'), 'approval card should keep approve option above composer');
  // 内联的 PlanCard（对话记录）与右侧面板并存
  assert(await page.locator('.pi-plan-card').count() === 1, 'conversation keeps the plan record card');
  await page.screenshot({ path: 'output/playwright/plan-approval-sidepanel.png' });

  // 批准后右侧面板保留（显示计划快照 + 清单进度），用户可手动关闭
  await page.locator('.pi-plan-approval__option').first().click();
  await page.waitForTimeout(300);
  assert(await page.locator('.pi-plan-viewer').count() === 1, 'plan viewer stays open after approve');
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS plan-approval-sidepanel: approval auto-opens right plan panel with full plan; approval card stays above composer; viewer persists after approve';
}
