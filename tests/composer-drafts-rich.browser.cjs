// Real Composer + Zustand draft routing + workspace history/IndexedDB.
// Run: playwright-cli run-code --filename tests/composer-drafts-rich.browser.cjs
async (page) => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('http://127.0.0.1:5175/rich-drafts', route => route.fulfill({
    contentType: 'text/html',
    body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>',
  }));
  await page.goto('http://127.0.0.1:5175/rich-drafts');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { Composer } = await import('/replica/chat/ChatView.tsx');
    const adapter = await import('/pi/adapter.ts');
    const { replicaLabels: labelsFor } = await import('/replica/i18n.ts');
    const history = await import('/replica/workspace-prompt-history.ts');
    const { usePiStore, writeComposerDraftText, composerOwnerKeyOf, resetComposerDrafts } = adapter;
    await import('/replica/tokens.css');
    await import('/replica/chat/chat.css');
    window.localPi = {
      history: async key => ({ session: { key }, branch: [], leaves: [] }),
      projectFiles: async () => [], composerSkills: async () => [],
    };
    resetComposerDrafts();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSykAAAAASUVORK5CYII=';
    const items = [
      { id: 'draft-image', kind: 'image', name: 'shot.png', path: '/shot.png', text: '', image: { type: 'image', mimeType: 'image/png', data: png } },
      { id: 'draft-file', kind: 'file', name: 'notes.txt', path: '/notes.txt', text: 'file content' },
      { id: 'draft-doc', kind: 'document', name: 'report.docx', path: '/report.docx', text: 'document content' },
      { id: 'draft-skill', kind: 'skill', name: 'pdf', path: '/pdf/SKILL.md', text: 'skill content' },
    ];
    usePiStore.setState({ selectedKey: 'browser-a', view: 'chat', env: undefined, draftCwd: '/browser-rich', draftText: '', contextItems: items });
    window.__draftStore = usePiStore;
    window.__historyModule = history;
    window.__items = items;
    let snapshot = null;
    const HISTORY = [
      { text: 'older', items: [items[1], items[2], items[3]] },
      { text: '', items: [items[0]] },
    ];
    function Shell() {
      const s = usePiStore();
      const composer = React.createElement(Composer, {
        key: composerOwnerKeyOf(s), draftText: s.draftText, draftOwnerKey: composerOwnerKeyOf(s),
        onDraftChange: writeComposerDraftText, sessionActive: Boolean(s.selectedKey),
        modelId: '', modelGroups: [], reasoning: 'off', agentMode: 'agent', permissionMode: 'ask',
        slashCommands: [], files: [], running: false, queued: 0, queue: [], demo: false,
        labels: labelsFor('zh').composer, hideReasoning: true, hasAttachments: s.contextItems.length > 0,
        promptHistory: HISTORY,
        onRestoreHistoryEntry: (text, items, phase) => {
          const st = usePiStore.getState();
          if (phase === 'enter') snapshot = { owner: composerOwnerKeyOf(st), text: st.draftText, items: st.contextItems };
          if (phase === 'exit') {
            const restored = snapshot?.owner === composerOwnerKeyOf(st) ? snapshot : { text: '', items: [] };
            snapshot = null;
            usePiStore.setState({ draftText: restored.text, contextItems: restored.items });
            return { text: restored.text };
          }
          usePiStore.setState({ draftText: text, contextItems: items.map((item, i) => ({ ...item, id: `history-${i}` })) });
        },
        onSend() {}, onStop() {}, onPickModel() {}, onPickReasoning() {}, onPickAgentMode() {}, onPickPermission() {},
        contextSlot: React.createElement('div', { 'data-testid': 'attachments' }, s.contextItems.map(item => React.createElement('span', { key: item.id }, item.name))),
      });
      // Move the Composer between tree locations to exercise real unmount cleanup.
      return React.createElement('main', { className: 'pireplica' },
        s.view === 'home' ? React.createElement('section', { key: 'home' }, composer)
          : React.createElement('article', { key: 'chat' }, composer));
    }
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Shell)));
  });
  const textarea = () => page.locator('.pi-composer textarea');
  await textarea().waitFor();
  // Switch within the 200ms debounce window, then wait for any stale timers.
  await textarea().fill('quick draft with tail');
  await page.evaluate(() => window.__draftStore.getState().selectSession('browser-b'));
  await page.waitForTimeout(250);
  assert(await textarea().inputValue() === '', 'A text must not pollute B');
  await textarea().fill('B draft');
  await page.evaluate(() => window.__draftStore.getState().selectSession('browser-a'));
  assert(await textarea().inputValue() === 'quick draft with tail', 'A tail survives immediate switch');
  assert(await page.locator('[data-testid=attachments]').textContent() === 'shot.pngnotes.txtreport.docxpdf', 'all A attachments restored');
  await page.evaluate(() => window.__draftStore.getState().startNewSession());
  await page.waitForTimeout(250);
  assert(await textarea().inputValue() === '', 'chat unmount must not overwrite home draft');
  await textarea().fill('home draft');
  await page.evaluate(() => window.__draftStore.getState().selectSession('browser-a'));
  assert(await textarea().inputValue() === 'quick draft with tail', 'chat remount restores A');
  await page.evaluate(() => window.__draftStore.getState().startNewSession());
  assert(await textarea().inputValue() === 'home draft', 'home draft survives round trip');
  // Same-owner reselect must not roll back to an older stashed copy.
  await page.evaluate(() => window.__draftStore.getState().selectSession('browser-a'));
  await textarea().fill('latest A');
  await page.evaluate(() => window.__draftStore.getState().selectSession('browser-a'));
  assert(await textarea().inputValue() === 'latest A', 'same owner retains latest local edit');
  // Image-only history must restore payload, and exit must restore pre-browse attachments.
  await textarea().fill('');
  await textarea().press('ArrowUp');
  let items = await page.evaluate(() => window.__draftStore.getState().contextItems);
  assert(items.length === 1 && items[0].image?.data, 'image-only prompt recalls its image');
  await textarea().press('ArrowUp');
  items = await page.evaluate(() => window.__draftStore.getState().contextItems);
  assert(items.map(item => item.kind).join(',') === 'file,document,skill', 'older prompt restores file/document/skill');
  await textarea().press('ArrowDown');
  await textarea().press('ArrowDown');
  items = await page.evaluate(() => window.__draftStore.getState().contextItems);
  assert(items.length === 4 && items[0].image?.data, 'exiting history restores full unsent attachment draft');
  assert(await textarea().inputValue() === '', 'enter snapshot sees locally deleted text, not stale store value');
  // Empty image-only text in A and empty B must still reset history navigation.
  await textarea().press('ArrowUp');
  await page.evaluate(() => window.__draftStore.getState().selectSession('browser-empty'));
  await textarea().press('ArrowUp');
  items = await page.evaluate(() => window.__draftStore.getState().contextItems);
  assert(items.length === 1 && items[0].kind === 'image', 'new empty owner starts at newest, not A old cursor');
  // Full history survives switching workspaces and localStorage quota, via IndexedDB.
  const persisted = await page.evaluate(async () => {
    const h = window.__historyModule;
    const cwd = `/rich-idb-${Date.now()}`;
    const big = { ...window.__items[0], image: { ...window.__items[0].image, data: 'a'.repeat(6 * 1024 * 1024) } };
    h.recordWorkspacePrompt(cwd, { text: '', items: [big, ...window.__items.slice(1)] });
    await h.loadWorkspacePromptHistory('/another-workspace');
    const returned = await h.loadWorkspacePromptHistory(cwd);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pi-desktop-prompt-history', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let disk;
    for (let i = 0; i < 40 && !disk; i++) {
      disk = await new Promise(resolve => {
        const request = db.transaction('workspaces').objectStore('workspaces').get(cwd);
        request.onsuccess = () => resolve(request.result);
      });
      if (!disk) await new Promise(resolve => setTimeout(resolve, 25));
    }
    db.close();
    return { memory: returned[0]?.items[0]?.image?.data.length, disk: disk?.[0]?.items[0]?.image?.data.length, kinds: disk?.[0]?.items.map(item => item.kind) };
  });
  assert(persisted.memory === 6 * 1024 * 1024 && persisted.disk === persisted.memory, 'large image remains complete in memory and IndexedDB');
  assert(persisted.kinds.join(',') === 'image,file,document,skill', 'disk history keeps all attachment types');
  await page.screenshot({ path: 'output/playwright/composer-drafts-rich.png' });
  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  return 'PASS rich drafts: rapid switch, unmount/remount, same owner, complete history, unsent snapshot, empty owner reset, large-image IndexedDB';
}
