// 模型设置页自适应布局：供应商列表(master)滚到最底部点击时，右侧模型列表(detail)
// 必须当场可见——之前整个页面滚动，点底部供应商后模型列表被滚出视口，要滚回页顶才能看到（用户反馈）。
// Vite at :5175; playwright-cli -s modsplit open about:blank; run-code --filename tests/models-split-adaptive.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('http://127.0.0.1:5175/models-split', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></body></html>' }));
  await page.goto('http://127.0.0.1:5175/models-split');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SettingsPage } = await import('/replica/settings/SettingsPage.tsx');
    const { replicaLabels } = await import('/replica/i18n.ts');
    await import('/replica/tokens.css'); await import('/replica/settings/settings.css'); await import('/pi/replica-app.css');
    const model = (id, extra) => ({ id, name: id.toUpperCase(), contextWindow: 200000, maxTokens: 8192, input: ['text'], ...extra });
    const providers = Array.from({ length: 10 }, (_, i) => ({
      id: `prov-${i}`, name: `供应商 ${i}`, baseUrl: `https://api.prov${i}.example.com/v1`,
      modelCount: 30, isDefault: i === 0, enabled: true, source: 'models.json', auth: 'api_key',
      models: Array.from({ length: 30 }, (_, n) => model(`prov-${i}-model-${n}`)),
    }));
    // 最后一个供应商只有 3 个模型（模拟截图里的 xAI）
    providers[9].models = providers[9].models.slice(0, 3);
    providers[9].modelCount = 3;
    providers[9].name = 'xAI'; providers[9].id = 'xai';
    providers[9].models = providers[9].models.map(m => ({ ...m, id: m.id.replace('prov-9', 'xai') }));
    const props = {
      page: 'models', query: '', theme: 'light', sections: [], providers,
      providerForm: { open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '' },
      defaultModelLabel: null, demo: false, labels: replicaLabels('zh').settings,
      onBack: () => {}, onSearch: () => {}, onSelectPage: () => {}, onRowControl: () => {},
      onSetProviderForm: () => {}, onSaveProvider: () => {}, onEditProvider: () => {},
      onDeleteProvider: () => {}, onToggleProvider: () => {}, onMakeDefault: () => {}, onRefreshCatalog: () => {},
      onSelectDefaultModel: () => {},
    };
    window.__props = props;
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica' },
      React.createElement(SettingsPage, props)));
  });
  await page.locator('.pi-models-split__nav').waitFor();

  // 1) 布局自适应：内容区不整页滚动（fill 模式），split 填满剩余可视高度
  const layout = await page.evaluate(() => {
    const content = document.querySelector('.pi-settings__content');
    const split = document.querySelector('.pi-models-split');
    const cs = getComputedStyle(content);
    return { fillClass: content.className.includes('pi-settings__content--fill'), overflow: cs.overflowY, display: cs.display, splitH: split.getBoundingClientRect().height, innerH: window.innerHeight };
  });
  assert(layout.fillClass && layout.overflow === 'hidden' && layout.display === 'flex', `content fill layout: ${JSON.stringify(layout)}`);
  assert(layout.splitH > 400, `split fills viewport height (${layout.splitH}px @ ${layout.innerH}px window)`);

  // 2) 点击供应商列表最底部一项：右侧模型列表当场可见（无需任何页面滚动）
  await page.locator('.pi-models-split__nav button', { hasText: 'xAI' }).click();
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const nav = document.querySelector('.pi-models-split__nav');
    const detail = document.querySelector('.pi-models-split__detail');
    const nr = nav.getBoundingClientRect(), dr = detail.getBoundingClientRect();
    const first = detail.querySelector('.pi-models-split__model');
    const head = detail.querySelector('.pi-models-split__title')?.textContent;
    const fr = first?.getBoundingClientRect();
    return {
      navScrollTop: nav.scrollTop, navScrollable: nav.scrollHeight > nav.clientHeight,
      detailTitle: head, detailModelCount: detail.querySelectorAll('.pi-models-split__model').length,
      detailScrollTop: detail.scrollTop, detailOverflow: getComputedStyle(detail).overflowY,
      firstVisible: fr ? fr.top >= dr.top - 1 && fr.bottom <= dr.bottom + 1 : false,
      detailTopInViewport: dr.top >= 0 && dr.top < window.innerHeight,
      pageScrolled: document.querySelector('.pi-settings__content').scrollTop,
    };
  });
  assert(after.navScrollable && after.navScrollTop > 0, `nav is independently scrollable and scrolled to bottom (top=${after.navScrollTop})`);
  assert(after.detailTitle === 'xAI', `detail shows clicked provider: ${after.detailTitle}`);
  assert(after.detailModelCount === 3, `detail shows its 3 models (got ${after.detailModelCount})`);
  assert(after.detailOverflow === 'auto', 'detail pane scrolls independently');
  assert(after.pageScrolled === 0, `page itself did not scroll (top=${after.pageScrolled})`);
  assert(after.detailTopInViewport, `detail pane top visible in viewport (top=${Math.round(after.detailTopInViewport ? 1 : 0)})`);
  assert(after.firstVisible, 'first model row fully visible right after clicking the bottom provider');

  // 3) 切换供应商后 detail 回到顶部
  await page.locator('.pi-models-split__nav button', { hasText: '供应商 3' }).click();
  await page.evaluate(() => { document.querySelector('.pi-models-split__detail').scrollTop = 500; });
  await page.locator('.pi-models-split__nav button', { hasText: '供应商 4' }).click();
  await page.waitForTimeout(150);
  const reset = await page.evaluate(() => ({
    title: document.querySelector('.pi-models-split__title')?.textContent,
    scrollTop: document.querySelector('.pi-models-split__detail').scrollTop,
  }));
  assert(reset.title === '供应商 4' && reset.scrollTop === 0, `detail resets to top on provider switch: ${JSON.stringify(reset)}`);

  // 4) 模型列表关键字过滤：匹配行数、计数徽标、空态、清空恢复
  await page.locator('.pi-models-split__filter').fill('model-2');
  await page.waitForTimeout(120);
  const filtered = await page.evaluate(() => ({
    rows: document.querySelectorAll('.pi-models-split__model').length,
    title: document.querySelector('.pi-models-split__listtitle')?.textContent,
  }));
  assert(filtered.rows === 11, `filter matches model-2 + model-20..29 (got ${filtered.rows})`);
  assert((filtered.title ?? '').includes('匹配 11'), `count badge shows matches: ${filtered.title}`);
  await page.locator('.pi-models-split__filter').fill('完全不匹配');
  await page.waitForTimeout(120);
  const empty = await page.evaluate(() => ({
    rows: document.querySelectorAll('.pi-models-split__model').length,
    hint: document.querySelector('.pi-models-split__models .pi-providerform__hint')?.textContent ?? '',
  }));
  assert(empty.rows === 0 && empty.hint.includes('没有匹配'), `empty state shown: ${JSON.stringify(empty)}`);
  await page.locator('.pi-models-split__filter').fill('');
  await page.locator('.pi-models-split__nav button', { hasText: '供应商 5' }).click();
  await page.waitForTimeout(120);
  const cleared = await page.evaluate(() => ({
    rows: document.querySelectorAll('.pi-models-split__model').length,
    filter: document.querySelector('.pi-models-split__filter')?.value,
  }));
  assert(cleared.rows === 30 && cleared.filter === '', `filter resets on provider switch: ${JSON.stringify(cleared)}`);

  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  await page.screenshot({ path: 'output/playwright/models-split-adaptive.png' });
  console.log('models-split-adaptive: all checks passed');
}
