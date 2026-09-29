// Run with: playwright-cli -s=memory-preview run-code "$(< tests/memory-preview.browser.cjs)"
// Uses the running Vite server on 5175. All host APIs are isolated in this page.
async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'http://127.0.0.1:5175/memory-preview-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.setViewportSize({ width: 960, height: 900 });
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { MemoryBrowser } = await import('/pi/MemoryControls.tsx');
    await import('/styles.css'); await import('/replica/tokens.css');
    await import('/pi/settings-features.css');
    window.reads = []; window.opens = []; window.lists = [];
    const files = Array.from({ length: 64 }, (_, i) => {
      const name = i === 2 ? `memory-02-${'longfilename'.repeat(18)}.md` : `memory-${String(i).padStart(2, '0')}.md`;
      return { name, rel: `daily/${name}`, path: `/mock/alpha/.pi/memory/daily/${name}`, scope: 'project', entries: 1, updatedAt: Date.now() };
    });
    window.localPi = {
      externalApps: async () => [{ id: 'finder', name: 'Finder', kind: 'finder' }, { id: 'vscode', name: 'VS Code', kind: 'editor' }],
      memoryList: async cwd => { window.lists.push(cwd); return files.map(f => ({ ...f, path: `${cwd || '/global'}/.pi/memory/${f.rel}` })); },
      memoryRead: (rel, cwd) => new Promise((resolve, reject) => window.reads.push({ rel, cwd, resolve, reject })),
      memoryOpen: async (rel, cwd, app) => { window.opens.push({ rel, cwd, app }); },
    };
    const props = { cwd: '/mock/alpha', projects: [{ path: '/mock/alpha', name: 'Alpha' }, { path: '/mock/beta', name: 'Beta' }] };
    function fixture(id) {
      return React.createElement('section', { 'data-testid': id, className: 'pi-features', style: { padding: 12, width: '100%', maxWidth: 880, boxSizing: 'border-box' } }, React.createElement(MemoryBrowser, props));
    }
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica', style: { height: 'auto', minHeight: '100vh', overflow: 'visible' } }, fixture('primary')));
    window.mountSecond = () => {
      const el = document.createElement('div'); el.className = 'pireplica'; document.body.append(el);
      createRoot(el).render(fixture('secondary'));
    };
  });
  let checks = 0;
  const assert = (value, message) => { if (!value) throw Error(message); checks++; };
  const tick = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const host = page.getByTestId('primary');
  const rows = host.locator('.pi-memory__row');
  const row = i => rows.nth(i);
  const toggle = i => row(i).locator('.pi-memory__open');
  const region = host.getByRole('region');
  const readCount = () => page.evaluate(() => window.reads.length);
  const open = async i => { const n = await readCount(); await toggle(i).click(); await page.waitForFunction(n => window.reads.length === n + 1, n); await tick(); return n; };
  const resolve = async (id, text) => { await page.evaluate(({ id, text }) => window.reads[id].resolve(text), { id, text }); await tick(); };
  const reject = async id => { await page.evaluate(id => window.reads[id].reject(new Error('fixture read denied')), id); await tick(); };
  const noPreview = async message => { await tick(); assert(await region.count() === 0, message); assert(await host.locator('.pi-memory__open[aria-expanded="true"]').count() === 0, `${message}: collapsed triggers`); };
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="primary"] .pi-memory__row').length === 64);
  assert(await rows.count() === 64, 'fixture has a long 64-record list');

  let id = await open(0);
  assert(await row(0).getByRole('status').innerText() === '正在读取预览…', 'loading belongs to first record immediately');
  assert(await row(0).getByRole('button', { name: '关闭', exact: true }).isVisible(), 'loading has a close control');
  const aria = await toggle(0).getAttribute('aria-controls');
  assert(aria === await region.getAttribute('id'), 'expanded trigger controls the actual region');
  assert(await toggle(0).getAttribute('aria-expanded') === 'true', 'trigger is expanded during loading');
  assert(await host.getByRole('region', { name: '预览：daily/memory-00.md', exact: true }).count() === 1, 'region has a file-specific accessible label');
  await resolve(id, 'First record preview');
  assert(await row(0).locator('pre').innerText() === 'First record preview', 'content stays in first row');
  const bounds = await host.evaluate(el => {
    const rows = el.querySelectorAll('.pi-memory__row'), preview = rows[0].querySelector('.pi-memory__preview');
    const p = preview.getBoundingClientRect(), second = rows[1].getBoundingClientRect(), last = rows[63].getBoundingClientRect();
    const button = rows[0].querySelector('.pi-memory__open').getBoundingClientRect(), tools = rows[0].querySelector('.pi-memory__tools').getBoundingClientRect();
    return { beforeSecond: !!(preview.compareDocumentPosition(rows[1]) & Node.DOCUMENT_POSITION_FOLLOWING), belowControls: p.top >= Math.max(button.bottom, tools.bottom), aboveSecond: p.bottom <= second.top, aboveLast: p.bottom < last.top, fullWidth: p.left <= button.left + 1 && p.right >= tools.right - 1 };
  });
  for (const [name, ok] of Object.entries(bounds)) assert(ok, `inline geometry / DOM order: ${name}`);
  await page.screenshot({ path: 'output/playwright/memory-preview-inline.png' });
  let count = await readCount();
  await toggle(0).click(); await noPreview('clicking the same record collapses');
  assert(await readCount() === count, 'collapse does not read again');

  id = await open(0);
  await region.getByRole('button', { name: '关闭', exact: true }).click();
  assert(await toggle(0).evaluate(el => el === document.activeElement), 'close restores keyboard focus to owning record');
  await resolve(id, 'must never reopen'); await noPreview('closing pending read invalidates success');
  id = await open(0); await toggle(0).click(); await reject(id); await noPreview('collapsing pending read invalidates error');

  id = await open(0); await reject(id);
  assert((await row(0).getByRole('alert').innerText()).includes('fixture read denied'), 'failure stays inside selected record');
  assert(await region.getByRole('button', { name: '关闭', exact: true }).isVisible(), 'error remains closable');
  count = await readCount();
  await region.getByRole('button', { name: '重试预览', exact: true }).click(); await tick();
  assert(await readCount() === count + 1, 'explicit retry starts one new read');
  assert(await row(0).getByRole('status').count() === 1 && await host.getByRole('alert').count() === 0, 'retry replaces error with inline loading');
  await resolve(count, 'Retry succeeded');
  assert(await region.locator('pre').innerText() === 'Retry succeeded', 'retry recovers content in same region');

  await toggle(0).click();
  const a = await open(0), b = await open(1);
  assert(await row(0).getByRole('region').count() === 0 && await row(1).getByRole('status').count() === 1, 'switching rows moves the only disclosure immediately');
  await resolve(a, 'stale A');
  assert(await row(1).getByRole('status').count() === 1 && await host.locator('pre').count() === 0, 'stale A success cannot replace B loading');
  await resolve(b, 'current B');
  assert(await row(1).locator('pre').innerText() === 'current B', 'B response owns content');
  const staleError = await open(0), current = await open(1);
  await resolve(current, 'new B'); await reject(staleError);
  assert(await row(1).locator('pre').innerText() === 'new B' && await host.getByRole('alert').count() === 0, 'late A error cannot replace successful B');

  count = await readCount();
  await row(0).locator('.pi-memory__launch').click(); await tick();
  assert(await readCount() === count && await row(1).getByRole('region').count() === 1, 'external launch on another row does not select or collapse');
  await row(1).getByRole('button', { name: 'memory-01.md 打开方式', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'VS Code', exact: true }).click(); await tick();
  assert(await readCount() === count && await row(1).getByRole('region').count() === 1, 'external open menu on selected row does not toggle');
  const opened = await page.evaluate(() => window.opens);
  assert(opened.length === 2 && opened[0].rel === 'daily/memory-00.md' && opened[1].app === 'vscode' && opened.every(o => o.cwd === '/mock/alpha'), 'external controls retain independent file / scope / app routing');

  id = await open(0);
  await host.getByRole('button', { name: '记忆项目', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Beta', exact: true }).click(); await tick();
  await resolve(id, 'old project'); await noPreview('project change clears and invalidates pending preview');
  id = await open(0);
  assert(await page.evaluate(id => window.reads[id].cwd, id) === '/mock/beta', 'new reads use newly selected scope');
  await host.getByRole('button', { name: '刷新记忆', exact: true }).click(); await tick();
  await reject(id); await noPreview('refresh clears and invalidates pending preview error');
  assert((await page.evaluate(() => window.lists)).filter(p => p === '/mock/beta').length === 2, 'refresh reloads current project');

  id = await open(0);
  const search = host.getByRole('textbox', { name: '搜索记忆文件', exact: true });
  await search.fill('memory-01'); await tick();
  assert(await rows.count() === 1, 'search filters the record list');
  await resolve(id, 'filtered pending result'); await noPreview('hidden record never leaks preview beneath list');
  await search.fill(''); await noPreview('clearing search does not resurrect filtered preview');
  id = await open(0); await resolve(id, 'visible match');
  await search.fill('memory-00'); await tick();
  assert(await region.locator('pre').innerText() === 'visible match', 'search preserves disclosure if record still matches');
  await search.fill('nothing-matches'); await noPreview('search also clears already-loaded preview');
  await search.fill('');

  await page.setViewportSize({ width: 360, height: 780 });
  id = await open(2); await resolve(id, `${'unbroken-content'.repeat(60)}\n${'line\n'.repeat(100)}`);
  await row(2).scrollIntoViewIfNeeded();
  const narrow = await row(2).evaluate(el => {
    const pre = el.querySelector('pre'), p = el.querySelector('.pi-memory__preview'), close = p.querySelector('button');
    return { bounded: pre.clientHeight <= 320, verticalScroll: pre.scrollHeight > pre.clientHeight, wrapped: pre.scrollWidth <= pre.clientWidth + 1, rowFits: el.getBoundingClientRect().right <= innerWidth, previewFits: p.scrollWidth <= p.clientWidth + 1, closeFits: close.getBoundingClientRect().right <= innerWidth, pageFits: document.documentElement.scrollWidth <= innerWidth };
  });
  for (const [name, ok] of Object.entries(narrow)) assert(ok, `narrow layout: ${name}`);
  await page.screenshot({ path: 'output/playwright/memory-preview-narrow.png' });

  await page.evaluate(() => window.mountSecond());
  const second = page.getByTestId('secondary');
  await second.locator('.pi-memory__open').first().click(); await tick();
  assert(await second.getByRole('region').count() === 1, 'second real MemoryBrowser fixture opens independently');
  assert(await second.getByRole('region').getAttribute('id') !== await region.getAttribute('id'), 'useId prevents collisions across browser instances');
  // Open the identical file in both instances, so uniqueness does not rely on file paths.
  await toggle(0).click(); await tick();
  assert(await second.getByRole('region').getAttribute('id') !== await region.getAttribute('id'), 'same file in two instances still has unique region ids');
  assert(errors.length === 0, errors.join('\n'));
  return { checks, errors, records: 64 };
}
