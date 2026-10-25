// Vite :5175. Real PiReplicaApp → ChatView → existing filePreview IPC → WorkbenchPanel.
// IPC results are synthetic; this test never reads personal files or launches a model.
async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || String(error)));
  await page.setViewportSize({ width: 1440, height: 960 });
  const url = 'http://127.0.0.1:5175/chat-file-preview-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css');
    const { default: App, usePiStore } = await import('/pi/PiReplicaApp.tsx');
    const cwd = '/mock/file-preview-project';
    const run = { key: 'file-preview-session', generation: 'g', cwd, file: '/mock/session.jsonl', status: 'idle', models: [], commands: [], pending: 0 };
    const branch = [{ type: 'message', id: 'answer', message: { role: 'assistant', timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: '调研完成。产出：`docs/design/research/claude-code-architecture.md`\n\n[定位源码](src/main.ts:8) · `docs/missing.md` · `docs/slow.md`\n\n~~~ts\nsrc/not-a-button.ts\n~~~' }] } }];
    window.fileCalls = []; window.opens = [];
    window.open = url => { window.opens.push(String(url)); return null; };
    window.localPi = new Proxy({
      onEvent: () => () => {},
      settingsSnapshot: async () => { throw Error('synthetic'); }, environment: async () => { throw Error('synthetic'); },
      sessions: async () => [], runs: async () => [run], archivedSessions: async () => [], packageList: async () => [], resources: async () => [], recoverSubagents: async () => [],
      history: async () => ({ branch, entries: branch, leaves: [] }),
      filePreview: async (root, file) => {
        window.fileCalls.push([root, file]);
        if (file === 'docs/slow.md') return new Promise(resolve => { window.resolveSlow = resolve; });
        if (file === 'docs/missing.md') return { path: root + '/' + file, note: '文件已不存在。', diff: '' };
        return { path: root + '/' + file, content: '# Claude Code 架构学习\n\n这是完整文件正文，不是工具修改快照。\n1\n2\n3\n4\n5\n6\n7\n8', diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new\n', note: '当前磁盘内容' };
      },
      projectBranch: async () => null, externalApps: async () => [],
      gitStatus: async () => ({ repository: false, branch: 'main', branches: [], files: [] }),
    }, { get: (target, key) => key in target ? target[key] : async () => undefined });
    usePiStore.getState().init();
    await new Promise(resolve => setTimeout(resolve, 0));
    usePiStore.setState({ ready: true, view: 'chat', lang: 'zh', selectedKey: run.key, runs: [run], sessions: [{ ...run, title: '文件预览', updatedAt: 1, source: 'desktop' }], history: { branch, entries: branch, leaves: [] }, sends: [], live: {}, toolProgress: {}, notifications: [], workbenchOpen: false, connecting: false, error: undefined });
    window.store = usePiStore;
    createRoot(document.getElementById('root')).render(React.createElement(App));
  });
  await page.locator('button[data-file-path="docs/design/research/claude-code-architecture.md"]').waitFor();
  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); checks++; };
  assert((await page.evaluate(() => window.fileCalls)).length === 0, 'render never reads disk');
  assert(await page.locator('pre button[data-file-path]').count() === 0, 'fenced examples stay code');
  await page.locator('button[data-file-path="docs/design/research/claude-code-architecture.md"]').click();
  await page.locator('.pi-file-code').waitFor();
  assert((await page.locator('.pi-file-code').innerText()).includes('Claude Code 架构学习'), 'right viewer shows full file');
  assert((await page.evaluate(() => window.fileCalls))[0].join('|') === '/mock/file-preview-project|docs/design/research/claude-code-architecture.md', 'relative path resolved against current project');
  assert(await page.evaluate(() => window.store.getState().workbenchTab) === 'files', 'message references show content even when git diff exists');
  assert(page.url() === url && (await page.evaluate(() => window.opens)).length === 0, 'no main-window or system-browser navigation');
  await page.locator('button[data-file-path="src/main.ts"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.pi-file-code__lines .is-focused')?.textContent === '8');
  assert(true, 'keyboard activation preserves source line');
  await page.locator('button[data-file-path="docs/missing.md"]').click();
  await page.getByText('文件已不存在。', { exact: true }).waitFor();
  assert(true, 'missing files show explicit feedback');
  await page.locator('button[data-file-path="docs/slow.md"]').click();
  await page.locator('button[data-file-path="docs/design/research/claude-code-architecture.md"]').click();
  await page.waitForFunction(() => document.querySelector('.pi-file-code')?.textContent.includes('Claude Code 架构学习'));
  await page.evaluate(() => window.resolveSlow({ path: '/mock/slow.md', content: 'STALE FILE', diff: '', note: '' }));
  assert(!(await page.locator('.pi-file-code').innerText()).includes('STALE FILE'), 'late file response cannot overwrite latest click');
  await page.screenshot({ path: 'output/playwright/chat-file-preview.png' });
  await page.locator('button[data-file-path="docs/slow.md"]').click();
  await page.locator('.pi-workbench__close').click();
  await page.evaluate(() => window.resolveSlow({ path: '/mock/slow.md', content: 'AFTER CLOSE', diff: '', note: '' }));
  assert(await page.evaluate(() => !window.store.getState().workbenchOpen), 'closing the viewer prevents late response reopening it');
  await page.locator('button[data-file-path="docs/slow.md"]').click();
  await page.evaluate(() => window.store.setState({ selectedKey: 'other-session', history: { branch: [], entries: [], leaves: [] } }));
  await page.evaluate(() => window.resolveSlow({ path: '/mock/slow.md', content: 'OLD SESSION CONTENT', diff: '', note: '' }));
  assert(await page.evaluate(() => !document.querySelector('.pi-workbench')?.textContent.includes('OLD SESSION CONTENT')), 'late response cannot leak into another session');
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, calls: await page.evaluate(() => window.fileCalls) };
}
