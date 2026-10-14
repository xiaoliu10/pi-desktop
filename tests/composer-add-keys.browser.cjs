// 「+」菜单（ComposerAdd）技能/文件候选列表键盘导航：↑/↓ 循环高亮、Enter 选中插入、Esc 关闭、
// 过滤后高亮重置到第一项、高亮项 scrollIntoView、aria-activedescendant 与 data-active 同步、hover 与键盘共用同一高亮。
// 复现用户反馈：技能选择列表不支持 ↑↓ 移动光标（此前只能鼠标点选）。
// 关键约束：12 个技能使列表溢出（max-height min(330px,45vh)）以验证 scrollIntoView；
// 搜索词 '07' 只命中 skill-07（文件列表刻意不含 '07'），保证过滤后候选唯一。
// Vite at :5175 (bind 127.0.0.1): npx vite --port 5175 --host 127.0.0.1
// playwright-cli -s composer-add open about:blank; run-code --filename tests/composer-add-keys.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 900, height: 800 });
  await page.route('http://127.0.0.1:5175/composer-add-keys', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/composer-add-keys');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { ComposerAdd } = await import('/pi/ComposerTools.tsx');
    await import('/replica/tokens.css');
    await import('/pi/replica-app.css');
    window.__added = [];
    window.localPi = {
      projectFiles: async () => ['README.md', 'src/index.ts'],
      composerSkills: async () => Array.from({ length: 12 }, (_, i) => {
        const n = String(i + 1).padStart(2, '0');
        return { id: 'sk-' + n, name: 'skill-' + n, path: '/skills/s' + n + '/SKILL.md', kind: 'skills', scope: 'shared', status: 'ready', detail: '技能 ' + n };
      }),
      pickDocuments: async () => [],
      resourceRead: async (id) => ({ text: '技能正文 ' + id }),
      projectContext: async (cwd, f) => ({ id: 'file:' + f, name: f, path: f, kind: 'file', text: '文件内容' }),
    };
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('div', { style: { position: 'fixed', bottom: 0, left: 0, right: 0, padding: 24 } },
      React.createElement(ComposerAdd, { cwd: '/proj', disabled: false, onAdd: (items) => { window.__added.push(...items); } })));
  });
  await page.locator('.pi-add').waitFor();
  const openMenu = async (options) => {
    await page.click('.pi-add > button');
    await page.locator('.pi-add__menu').waitFor();
    await page.waitForFunction((n) => document.querySelectorAll('.pi-add__list [role=option]').length === n, options, { timeout: 5000 });
    assert(await page.evaluate(() => document.activeElement && document.activeElement.closest('.pi-add__menu input') !== null), 'search input should be focused on open');
  };
  const activeText = () => page.locator('.pi-add__list [data-active=true] span').first().innerText();

  // 1) 「添加」页：选项 = 2 个动作行 + 12 个技能；初始高亮第一项（添加文档），aria 语义齐备
  await openMenu(14);
  assert(await page.locator('.pi-add__menu input[role=combobox]').count() === 1, 'input should expose combobox role');
  assert(await page.locator('.pi-add__list[role=listbox]').count() === 1, 'list should expose listbox role');
  let active = await activeText();
  assert(active.includes('添加文档'), `initial active should be 添加文档, got ${active}`);
  const ariaSync = await page.evaluate(() => {
    const input = document.querySelector('.pi-add__menu input');
    const opt = document.querySelector('.pi-add__list [data-active=true]');
    return input.getAttribute('aria-activedescendant') === opt.id && opt.getAttribute('aria-selected') === 'true';
  });
  assert(ariaSync, 'aria-activedescendant should reference the data-active option');

  // 2) ↓↓ 移到第一个技能（skill-01），Enter 选中 → onAdd 收到 skill 附件、菜单关闭、焦点回触发按钮
  await page.keyboard.press('ArrowDown');
  active = await activeText();
  assert(active.includes('添加项目上下文'), `after 1x ArrowDown active should be 添加项目上下文, got ${active}`);
  await page.keyboard.press('ArrowDown');
  active = await activeText();
  assert(active.includes('skill-01'), `after 2x ArrowDown active should be skill-01, got ${active}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__added.length === 1, undefined, { timeout: 5000 });
  const first = await page.evaluate(() => window.__added[0]);
  assert(first.kind === 'skill' && first.name === 'skill-01' && first.text === '技能正文 sk-01', `Enter should insert skill-01, got ${JSON.stringify(first)}`);
  assert(await page.locator('.pi-add__menu').count() === 0, 'menu should close after Enter selection');

  // 3) 「使用技能」页：↑ 从首项循环到末项（skill-12）并滚入视野；↓ 再循环回首项
  await openMenu(14);
  await page.click('.pi-add__tabs button:nth-child(3)');
  await page.waitForFunction(() => document.querySelectorAll('.pi-add__list [role=option]').length === 12, undefined, { timeout: 5000 });
  active = await activeText();
  assert(active.includes('skill-01'), `tab switch should reset highlight to first, got ${active}`);
  await page.keyboard.press('ArrowUp');
  active = await activeText();
  assert(active.includes('skill-12'), `ArrowUp from first should wrap to skill-12, got ${active}`);
  let box = await page.evaluate(() => {
    const list = document.querySelector('.pi-add__list').getBoundingClientRect();
    const opt = document.querySelector('.pi-add__list [data-active=true]').getBoundingClientRect();
    return { listTop: list.top, listBottom: list.bottom, optTop: opt.top, optBottom: opt.bottom };
  });
  assert(box.optBottom <= box.listBottom + 1 && box.optTop >= box.listTop - 1, `wrapped last option must scroll into view: ${JSON.stringify(box)}`);
  await page.keyboard.press('ArrowDown');
  active = await activeText();
  assert(active.includes('skill-01'), `ArrowDown from last should wrap to skill-01, got ${active}`);
  box = await page.evaluate(() => {
    const list = document.querySelector('.pi-add__list').getBoundingClientRect();
    const opt = document.querySelector('.pi-add__list [data-active=true]').getBoundingClientRect();
    return { listTop: list.top, listBottom: list.bottom, optTop: opt.top, optBottom: opt.bottom };
  });
  assert(box.optTop >= box.listTop - 1 && box.optBottom <= box.listBottom + 1, `wrapped first option must scroll into view: ${JSON.stringify(box)}`);

  // 4) 过滤后高亮重置到第一项：先 ↓↓ 移走，再输入 '07' → 唯一候选 skill-07 高亮；Enter 插入
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  active = await activeText();
  assert(active.includes('skill-03'), `after 2x ArrowDown active should be skill-03, got ${active}`);
  await page.fill('.pi-add__menu input', '07');
  await page.waitForFunction(() => document.querySelectorAll('.pi-add__list [role=option]').length === 1, undefined, { timeout: 5000 });
  active = await activeText();
  assert(active.includes('skill-07'), `filter should reset highlight to first hit (skill-07), got ${active}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__added.length === 2, undefined, { timeout: 5000 });
  const second = await page.evaluate(() => window.__added[1]);
  assert(second.kind === 'skill' && second.name === 'skill-07', `Enter after filter should insert skill-07, got ${JSON.stringify(second)}`);

  // 5) Esc 关闭并把焦点还给触发按钮
  await openMenu(14);
  await page.keyboard.press('Escape');
  assert(await page.locator('.pi-add__menu').count() === 0, 'Escape should close the menu');
  assert(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label') === '添加上下文、文档或技能'), 'Escape should refocus the trigger button');

  // 6) hover 与键盘共用同一高亮：悬停 idx2（skill-01）后 ↓ 应移到 idx3（skill-02）
  await openMenu(14);
  await page.hover('[data-add-idx="2"]');
  active = await activeText();
  assert(active.includes('skill-01'), `hover should move the highlight to skill-01, got ${active}`);
  await page.keyboard.press('ArrowDown');
  active = await activeText();
  assert(active.includes('skill-02'), `ArrowDown after hover should move to skill-02, got ${active}`);

  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await page.locator('.pi-add').screenshot({ path: 'output/playwright/composer-add-keys.png' });
  return 'PASS composer-add-keys: ↑/↓ cyclic highlight + Enter insert + Esc close + filter reset + scrollIntoView + aria sync + hover/keyboard single highlight';
}
