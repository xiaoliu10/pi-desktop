// Synthetic UI regression; Vite on :5198. No user data or model access.
// playwright-cli -s=history-target run-code --filename tests/session-history-target.browser.cjs
async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5198/history-target', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5198/history-target');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { default: App, usePiStore } = await import('/pi/PiReplicaApp.tsx');
    await import('/styles.css');
    window.__store = usePiStore;
    const cwd = '/synthetic/history';
    const source = { key: 'source', id: 'source', path: '/synthetic/source.jsonl', cwd, name: 'History route regression', updatedAt: 1, size: 100, warnings: [], owned: false };
    const copy = { ...source, key: 'copy', id: 'copy', path: '/synthetic/copy.jsonl', parentSession: source.path, owned: true, updatedAt: 2 };
    const run = { key: 'copy', generation: 'g', cwd, file: copy.path, status: 'idle', models: [], commands: [], pending: 0 };
    window.__calls = { prompt: 0, connect: 0, history: [], resolve: 0 };
    const snapshot = { preferences: { behavior: 'followUp', permission: 'ask', shortcuts: {}, projects: [{ path: cwd, name: 'History fixture' }] }, ai: {}, resources: [], mcp: [], mcpRevisions: {}, diagnostics: [], projects: [], loadedExtensions: [] };
    window.localPi = new Proxy({
      settingsSnapshot: async () => snapshot, environment: async () => ({ supported: true, version: '1.3.0' }),
      sessions: async () => [source, copy], runs: async () => [], archivedSessions: async () => [], onEvent: () => () => {},
      resolveSession: async () => { window.__calls.resolve++; return 'copy'; },
      history: async key => { window.__calls.history.push(key); return { session: key === 'copy' ? copy : source, entries: [], branch: [{ id: key + '-answer', type: 'message', timestamp: '2026-10-20T07:14:05Z', message: { role: 'assistant', content: [{ type: 'text', text: key === 'copy' ? 'LATEST_EXISTING_DESKTOP_CONTENT' : 'OLD_EXTERNAL_CONTENT' }] } }], leaves: [], leafId: key + '-answer', syncedAt: 1 }; },
      connect: async () => { window.__calls.connect++; return run; }, prompt: async () => { window.__calls.prompt++; },
      gitStatus: async () => ({ repository: false, root: cwd, branch: '', branches: [], changed: 0 }),
      modelCatalog: async () => ({ providers: [], diagnostics: [] }), externalApps: async () => [],
      subagentCapabilityStatus: async () => ({ available: false }), recoverSubagents: async () => [], projectBranch: async () => null,
    }, { get: (target, key) => key in target ? target[key] : async () => [] });
    usePiStore.getState().init();
    await new Promise(resolve => setTimeout(resolve, 30));
    usePiStore.setState({ ready: true, selectedKey: null, sessions: [source, copy], runs: [], history: undefined, sends: [], live: {}, toolProgress: {}, view: 'home', lang: 'en', workbenchOpen: false, expandedProjects: [cwd], draftText: '', contextItems: [] });
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  await page.getByText('History route regression', { exact: true }).first().click();
  await page.getByText('LATEST_EXISTING_DESKTOP_CONTENT', { exact: true }).waitFor({ timeout: 10000 });
  const first = await page.evaluate(() => ({ key: window.__store.getState().selectedKey, calls: window.__calls }));
  if (first.key !== 'copy' || first.calls.prompt !== 0) throw new Error('Opening must retarget without sending: ' + JSON.stringify(first));
  if (await page.getByText('OLD_EXTERNAL_CONTENT', { exact: true }).count()) throw new Error('Old snapshot remains rendered');
  await page.evaluate(() => window.__store.getState().selectSession('source'));
  await page.waitForTimeout(800);
  await page.getByText('LATEST_EXISTING_DESKTOP_CONTENT', { exact: true }).waitFor();
  const final = await page.evaluate(() => ({ key: window.__store.getState().selectedKey, prompts: window.__calls.prompt, tip: window.__store.getState().history?.branch.at(-1)?.id }));
  if (final.key !== 'copy' || final.prompts !== 0 || final.tip !== 'copy-answer') throw new Error(JSON.stringify(final));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: real sidebar click and reopen render existing Desktop history; no prompt, no old source snapshot; ' + JSON.stringify(final));
}
