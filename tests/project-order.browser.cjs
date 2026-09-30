// Real buildPiSidebar + Sidebar (no harness-side project sorting / no user configuration writes).
// Vite at :5175; playwright-cli -s projectorder open about:blank
// playwright-cli -s projectorder run-code --filename tests/project-order.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/project-order', route => route.fulfill({
    contentType: 'text/html',
    body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>',
  }));
  await page.setViewportSize({ width: 1000, height: 1100 });
  await page.goto('http://127.0.0.1:5175/project-order');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { buildPiSidebar } = await import('/pi/adapter.ts');
    const { pendingAttentionBySession } = await import('/pi/PiReplicaApp.tsx');
    const { Sidebar } = await import('/replica/shell/Sidebar.tsx');
    await import('/replica/tokens.css');
    await import('/replica/shell/sidebar.css');
    await import('/pi/replica-app.css');
    const projects = [
      { path: '/w/z-pin', name: 'Z pinned', pinned: true, section: 'Work' },
      { path: '/w/z-work', name: 'Z work', section: 'Work' },
      { path: '/w/a-pin', name: 'A pinned', pinned: true, section: 'Personal' },
      { path: '/w/a-work', name: 'A work', section: 'Work' },
      { path: '/w/empty', name: 'Empty saved project' },
      { path: '/w/hidden', name: 'Hidden project', pinned: true },
    ];
    const session = (cwd, key, updatedAt) => ({ cwd, key, id: key, path: `${cwd}/${key}.jsonl`, name: key, updatedAt, owned: true, size: 1, warnings: [] });
    const root = createRoot(document.getElementById('root'));
    window.renderProjectOrder = tick => {
      const hot = ['/w/z-pin', '/w/z-work', '/w/a-pin', '/w/a-work'][tick % 4];
      let sessions = projects.filter(p => p.path !== '/w/empty').map((p, i) => session(p.path, `${p.name} chat`, p.path === hot ? 9000 : 100 + i));
      sessions.push(session('/w/z-work', 'work-old', tick % 2 ? 30000 : 20000));
      if (tick > 0) sessions.push(session('/w/z-work', 'work-new', tick % 2 ? 20000 : 30000));
      sessions.push(session('/w/auto-z', 'archive-only', 100000), session('/w/auto-a', 'discovered', tick * 100000));
      sessions = [...sessions.slice(tick % 5), ...sessions.slice(0, tick % 5)];
      if (tick % 2) sessions.reverse();
      const status = tick % 3 === 0 ? 'running' : tick % 3 === 1 ? 'idle' : 'starting';
      const runs = [...sessions].reverse().map(s => ({ cwd: s.cwd, key: s.key, status, generation: 'g', file: '', pending: tick % 3, models: [], commands: [], timing: { startedAt: tick * 9999 } }));
      runs.push({ cwd: '/w/orphan', key: 'orphan', status, generation: 'g', file: '', pending: 0, models: [], commands: [] });
      runs.push({ cwd: '/w/hidden', key: 'hidden-orphan', status, generation: 'g', file: '', pending: 0, models: [], commands: [] });
      const named = projects.map(p => ({ ...p, name: p.path === '/w/z-work' && tick % 2 ? 'Renamed work' : p.name }));
      const sidebar = buildPiSidebar(sessions, runs, ['/w/z-work', '/w/empty', '/w/auto-z'], {}, { projects: named, hiddenProjects: ['/w/hidden'] }, ['archive-only']);
      const attention = pendingAttentionBySession([{ key: 'work-old', generation: 'g', request: { id: 'approve', method: 'confirm', title: 'Desktop approval' } }]);
      // Same attention decoration as PiReplicaApp; no changes to the helper's project order.
      sidebar.projects.forEach(p => { p.sessions = p.sessions.map(s => ({ ...s, ...attention[s.id] })); });
      window.projectOrderProbe = { paths: sidebar.projects.map(p => p.path), temporary: sidebar.temporary.map(s => s.id) };
      root.render(React.createElement('main', { className: 'pireplica', 'data-tick': tick }, React.createElement(Sidebar, {
        projects: sidebar.projects, temporarySessions: sidebar.temporary, activeSessionId: null,
        collapsed: false, version: 'project order regression',
        labels: { projects: '项目', sessions: '会话', search: '搜索', settings: '设置', plugins: '插件', notifications: '通知', readOnlyBadge: '只读', noChats: '暂无会话' },
        onSelectSession: () => {}, onNewSession: () => {}, onToggleProject: () => {}, onToggleCollapse: () => {},
        onOpenSettings: () => {}, onOpenPlugins: () => {}, onToggleNotifications: () => {},
      })));
    };
  });

  const paths = ['/w/z-pin', '/w/a-pin', '/w/z-work', '/w/a-work', '/w/empty', '/w/auto-a', '/w/auto-z'];
  for (let tick = 0; tick < 12; tick++) {
    await page.evaluate(tick => window.renderProjectOrder(tick), tick);
    await page.waitForFunction(tick => document.querySelector('main')?.dataset.tick === String(tick), tick);
    const state = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.pi-sidebar__project')];
      const work = rows[2];
      return {
        probe: window.projectOrderProbe,
        names: rows.map(p => p.querySelector('.pi-sidebar__projrow > .pi-sidebar__rowtitle').textContent),
        workSessions: [...work.querySelectorAll('.pi-sidebar__session .pi-sidebar__rowtitle')].map(s => s.textContent),
        hasBadge: !!work.querySelector('.pi-sidebar__confirm--permission'),
        hasSpinner: !!work.querySelector('[aria-label="任务运行中"]'),
        sections: [...document.querySelectorAll('.pi-sidebar__sectionlabel')].map(s => s.textContent),
        emptyCount: document.querySelectorAll('.pi-sidebar__empty').length,
      };
    });
    assert(JSON.stringify(state.probe.paths) === JSON.stringify(paths), `tick ${tick}: stable paths ${JSON.stringify(state)}`);
    assert(JSON.stringify(state.names) === JSON.stringify(['Z pinned', 'A pinned', tick % 2 ? 'Renamed work' : 'Z work', 'A work', 'Empty saved project', 'auto-a', 'auto-z']), `tick ${tick}: DOM order ${JSON.stringify(state)}`);
    assert(state.workSessions[0] === (tick === 0 || tick % 2 ? 'work-old' : 'work-new'), `tick ${tick}: sessions stay recent-first`);
    assert(state.hasSpinner === (tick % 3 !== 1), `tick ${tick}: running/starting/idle update in place`);
    assert(state.hasBadge, `tick ${tick}: permission badge preserved`);
    assert(state.emptyCount === 2, `tick ${tick}: saved empty + discovered archive-only projects visible`);
    assert(JSON.stringify(state.sections) === JSON.stringify(['置顶', 'Work', '项目']), `tick ${tick}: groups preserved`);
    assert(JSON.stringify(state.probe.temporary) === JSON.stringify(['orphan']), `tick ${tick}: hidden/archived runs excluded`);
  }
  await page.screenshot({ path: 'output/playwright/project-order.png' });
  assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  return 'PASS project-order: 12 rotations of timestamps, input order, progress, new sessions and rename; real helper + Sidebar, stable groups, recency, empty/archived/hidden projects, temporary runs and attention badge';
}
