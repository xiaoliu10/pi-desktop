// 技能页资源范围选择器（ZCode 式）：紧凑 pill 下拉 + 资源计数 + 范围提示；切换项目后 snapshot 按项目重拉、项目技能入列。
// playwright-cli -s scopepill open http://127.0.0.1:5175 && playwright-cli -s scopepill run-code --filename tests/skills-scope-pill.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('http://127.0.0.1:5175/scope-pill', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/scope-pill');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { SettingsFeatures } = await import('/pi/SettingsFeatures.tsx');
    await import('/replica/tokens.css'); await import('/pi/settings-features.css'); await import('/pi/replica-app.css');
    const snapCalls = [];
    const res = (name, scope) => ({ kind: 'skills', name, path: scope === 'project' ? '/mock/pi-virtual/.pi/skills/' + name + '/SKILL.md' : '/mock/agent/skills/' + name + '/SKILL.md', scope, editable: true, detail: scope === 'project' ? '项目专属技能' : '全局技能' });
    window.localPi = {
      settingsSnapshot: async (project) => { snapCalls.push(project || ''); const scope = project ? 'project' : 'user'; return {
        preferences: { behavior: 'followUp', permission: 'ask', shortcuts: {} }, ai: {},
        projects: [{ path: '/mock/pi-virtual', name: 'pi-virtual-employee' }, { path: '/mock/wengine', name: 'wengine-ai-workbench' }],
        resources: scope === 'project' ? [res('deploy-helper', 'project'), res('code-review', 'project')] : [res('brainstorming', 'user'), res('docx', 'user'), res('pptx', 'user')],
        mcp: [], mcpRevisions: {}, diagnostics: [], loadedExtensions: [],
      }; },
      onEvent: () => () => {},
      environment: () => new Promise(() => {}), sessions: async () => [], runs: async () => [], archivedSessions: async () => [],
      listFiles: async () => [], projectBranch: async () => null, gitStatus: async () => ({ isRepo: false, files: [] }),
      memoryAssistStatus: async () => ({ enabled: false, plugin: { kind: 'builtin' }, builtinDir: '/mock/agent/memory', hint: '' }),
      scanResources: async () => {}, createResource: async () => {}, saveResource: async () => {}, readResource: async () => ({ content: '' }),
    };
    window.snapCalls = snapCalls;
    createRoot(document.getElementById('root')).render(React.createElement('main', { className: 'pireplica' },
      React.createElement(SettingsFeatures, { page: 'skills', cwd: '', query: '' })));
  });
  await page.locator('.pi-features__scopebar').waitFor();
  await page.waitForTimeout(250);
  // 1) pill 形态：select 宽度受限（非全宽）
  const m = await page.evaluate(() => {
    const sel = document.querySelector('.pi-features__scope select');
    const bar = document.querySelector('.pi-features__scopebar').getBoundingClientRect();
    const r = sel.getBoundingClientRect();
    return { selW: Math.round(r.width), barW: Math.round(bar.width), count: document.querySelector('.pi-features__count')?.textContent, hint: document.querySelector('.pi-features__scopehint')?.textContent };
  });
  assert(m.selW < 400 && m.selW < m.barW * 0.6, `scope select should be compact pill, got width ${m.selW} of bar ${m.barW}`);
  assert((m.count || '').includes('技能 3'), `count shows global skill count, got ${m.count}`);
  assert((m.hint || '').includes('全局资源'), `hint explains global scope, got ${m.hint}`);
  // 2) 切换项目 → snapshot 以项目路径重拉，列表变为项目资源
  await page.selectOption('.pi-features__scope select', '/mock/pi-virtual');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    snapCalls: window.snapCalls,
    names: [...document.querySelectorAll('.pi-features code')].map(c => c.textContent).filter(t => t?.includes('SKILL')).length,
    rows: [...document.querySelectorAll('.pi-features__badge, .pi-features code')].length,
    hint: document.querySelector('.pi-features__scopehint')?.textContent,
  }));
  assert(after.snapCalls.includes('/mock/pi-virtual'), `snapshot refetched with project path: ${JSON.stringify(after.snapCalls)}`);
  assert((after.hint || '').includes('pi-virtual-employee'), `hint names selected project, got ${after.hint}`);
  assert(await page.evaluate(() => document.body.textContent.includes('deploy-helper')), 'project skill listed after switching scope');
  await page.screenshot({ path: 'output/playwright/skills-scope-pill.png' });
}
