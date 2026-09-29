async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'http://127.0.0.1:5175/ui-recovery-harness';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css'); await import('/replica/tokens.css');
    const { ChatView } = await import('/replica/chat/ChatView.tsx');
    const { SettingsPage } = await import('/replica/settings/SettingsPage.tsx');
    await import('/replica/shell/sidebar.css'); await import('/pi/replica-app.css');
    const { replicaLabels } = await import('/replica/i18n.ts');
    const h = React.createElement, root = createRoot(document.getElementById('root'));
    const L = replicaLabels('zh');
    window.downloads = 0; window.refreshes = 0; window.copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.copied = t; } } });
    const image = { kind: 'image', id: 'i', mimeType: 'image/svg+xml', data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#fafafa"/><rect x="40" y="40" width="250" height="720" rx="20" fill="#e4e7ec"/><text x="340" y="110" fill="#253047" font-family="sans-serif" font-size="32">Image preview</text></svg>') };
    const user = { id: 'u', role: 'user', timestamp: Date.now()-5000, parts: [image] };
    const fail = { id: 'f', role: 'assistant', modelOutcome: 'error', parts: [{ kind: 'error', source: 'model', id: 'err', message: 'fetch failed', details: 'ECONNREFUSED\nAuthorization: Bearer SECRET' }] };
    window.renderCase = (mode, dark = false) => {
      const messages = mode === 'image' ? [user] : [{ ...user, parts: [{ id: 'p', kind: 'text', text: '请检查' }] }];
      if (['retry', 'failed', 'recovered'].includes(mode)) messages.push(fail);
      if (mode === 'recovered') messages.push({ id: 'ok', role: 'assistant', modelOutcome: 'success', parts: [{ kind: 'text', id: 'ok-t', text: '已经恢复工作' }] });
      root.render(h('main', { className: `pireplica${dark ? ' pireplica--dark' : ''}`, style: { height: '100vh' } }, h(ChatView, {
        key: mode, messages, running: ['waiting', 'retry'].includes(mode), queued: 0, demo: false, labels: L.chat, onJumpToMessage: () => {},
        runTiming: { startedAt: Date.now()-5000 }, onDownloadImage: () => window.downloads++, onRefreshProcess: async () => { window.refreshes++; return true; },
        retrying: mode === 'retry' ? { attempt: 1, max: 3, error: 'fetch failed', phase: 'requesting' } : undefined,
      })));
    };
    window.renderSettings = (dark = false) => {
      const render = selected => root.render(h('main', { className: `pireplica pireplica--settings${dark ? ' pireplica--dark' : ''}`, style: { height: '100vh' } },
        h('div', { className: 'pi-settings-wrap', style: { position: 'fixed', inset: 0, zIndex: 60 } }, h('div', { className: 'pi-dragstrip' }), h(SettingsPage, {
          page: selected, query: '', demo: false, labels: L.settings, onSelectPage: id => { window.selectedPage = id; render(id); }, onSearch: () => {}, onBack: () => {},
          pageContent: h('h1', null, selected),
        })), h('aside', { className: 'pi-sidebar' }, h('div', { className: 'pi-sidebar__top' }, 'native drag background')),
        h('div', { className: 'pireplica__main' }, h('div', { style: { position: 'fixed', inset: 0, zIndex: 1200 } }, 'background popup'))));
      render('general');
    };
  });
  let checks = 0;
  const assert = (v, msg) => { if (!v) throw Error(msg); checks++; };
  for (const width of [1280, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(d => window.renderCase('image', d), dark);
    await page.locator('.pi-msg__imagebtn').click();
    const box = page.locator('.pi-lightbox');
    await box.waitFor();
    const geometry = await box.evaluate(el => {
      const bar = el.querySelector('.pi-lightbox__bar'), b = bar.getBoundingClientRect(), btn = bar.querySelector('button'), r = btn.getBoundingClientRect();
      return { top: b.top, right: innerWidth - b.right, w: r.width, h: r.height, color: getComputedStyle(btn).color, parent: el.parentElement.tagName };
    });
    assert(geometry.top >= 12 && geometry.top <= 24 && geometry.right <= 24 && geometry.right >= 12, JSON.stringify(geometry));
    assert(geometry.w === 44 && geometry.h === 44 && geometry.color === 'rgb(32, 33, 36)' && geometry.parent === 'BODY', 'portal button styles');
    await box.getByRole('button', { name: '下载图片' }).click();
    assert(await box.count() === 1, 'download must keep preview open');
    if (width === 1280 && !dark) await page.screenshot({ path: 'output/playwright/lightbox-toolbar-after.png' });
    await box.getByRole('button', { name: '关闭' }).click();
    assert(await box.count() === 0, 'close');
    await page.locator('.pi-msg__imagebtn').click(); await page.keyboard.press('Escape');
    assert(await box.count() === 0, 'escape');
    await page.locator('.pi-msg__imagebtn').click(); await box.click({ position: { x: 5, y: 100 } });
    assert(await box.count() === 0, 'backdrop');
    await page.evaluate(d => window.renderSettings(d), dark);
    for (const name of ['快捷键', '语音输入']) {
      const button = page.getByRole('button', { name, exact: true });
      await button.hover();
      assert(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) && getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'no-drag'; }), `${name} hit/no-drag`);
      await button.click();
      assert(await button.getAttribute('aria-current') === 'page', `${name} navigation`);
    }
    assert(await page.locator('.pi-sidebar').evaluate(el => getComputedStyle(el).display === 'none'), 'background native regions hidden');
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.evaluate(() => window.renderCase('waiting'));
  await page.locator('.pi-waiting-process summary').click();
  await page.getByRole('button', { name: '重新同步过程' }).click();
  assert(await page.evaluate(() => window.refreshes) === 1, 'refresh callback');
  assert(await page.getByRole('status').filter({ hasText: '已同步已保存' }).count() === 1, 'refresh confirmation');
  await page.screenshot({ path: 'output/playwright/waiting-process-after.png' });
  await page.evaluate(() => window.renderCase('failed'));
  await page.locator('.pi-error-card summary').click();
  await page.getByRole('button', { name: '复制错误详情' }).click();
  assert(await page.evaluate(() => window.copied.includes('ECONNREFUSED') && !window.copied.includes('SECRET')), 'sanitized copy');
  await page.evaluate(() => window.renderCase('retry'));
  await page.locator('.pi-chat__retry').waitFor();
  assert(await page.locator('.pi-error-card').count() === 0, 'retry suppresses error');
  assert(!(await page.locator('#root').innerText()).includes('fetch failed'), 'retry no error text');
  await page.evaluate(() => window.renderCase('recovered'));
  await page.getByText('已经恢复工作').waitFor();
  assert(await page.locator('.pi-error-card').count() === 0, 'success hides old error');
  await page.evaluate(() => window.renderCase('failed'));
  await page.locator('.pi-error-card').waitFor();
  assert(await page.locator('.pi-error-card').count() === 1, 'exhausted retry shows cause');
  assert(errors.length === 0, errors.join('\n'));
  console.log(JSON.stringify({ checks, errors }));
}
