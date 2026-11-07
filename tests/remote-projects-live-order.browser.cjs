// Mobile viewer: a project with a running/starting task must be pinned above
// newer idle projects. Fixture is the exact viewerPage() output; a unit test
// keeps it byte-identical so this browser test cannot drift from the source.
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = [];
  let stage = 'load-fixture';
  page.on('pageerror', e => errors.push(String(e)));
  page.on('requestfailed', r => errors.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`));

  // viewerPage() 是 main-process TS；fixture 由单元测试保证与源码字节一致，
  // 浏览器通过 route.fulfill 加载同一份 HTML，再用 mock transport 执行内嵌脚本。
  await page.route('http://127.0.0.1:5178/remote-viewer', route => route.fulfill({
    path: 'tests/fixtures/remote-viewer.html',
    contentType: 'text/html; charset=utf-8',
  }));
  const order = () => page.evaluate(() => (
    [...document.querySelectorAll('#projList .proj')]
      .map(el => decodeURIComponent(el.getAttribute('data-open')))
  ));

  const state = {
    desktopVersion: 'test',
    version: '1.5.0-test',
    sessions: [
      { key: 'idle', cwd: '/tmp/newer-idle', name: 'Newer Idle', updatedAt: 999 },
      { key: 'live', cwd: '/tmp/older-live', name: 'Older Live', updatedAt: 100 },
      { key: 'starting', cwd: '/tmp/mid-live', name: 'Mid Starting', updatedAt: 500 },
    ],
    runs: [
      { key: 'idle', status: 'idle' },
      { key: 'live', status: 'idle' },
      { key: 'starting', status: 'starting' },
    ],
  };
  await page.addInitScript((remoteState) => {
    window.__REMOTE_STATE__ = remoteState;
    window.__SSE_MESSAGES__ = [];
    window.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => window.__REMOTE_STATE__,
    });
    window.EventSource = class {
      constructor() {
        window.__sse = this;
        window.__sseInstances = (window.__sseInstances || []);
        window.__sseInstances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
    };
  }, state);

  let reordered;
  try {
  await page.goto('http://127.0.0.1:5178/remote-viewer', { waitUntil: 'domcontentloaded' });
  stage='wait-initial-card';
  await page.waitForSelector('#projList .proj', { timeout: 10000 });
  stage='wait-initial-count';
  await page.waitForFunction(() => document.querySelectorAll('#projList .proj').length === 3, undefined, { timeout: 10000 });
  assert(await page.locator('[data-open="%2Ftmp%2Fmid-live"]').isVisible(), 'starting badge/project visible');

  // SSE run 状态从 idle 变 running：列表必须实时重排，旧的 live 项目压过更新的 idle 项目。
  stage='dispatch-sse';
  await page.evaluate(() => window.__sse.onmessage({
    data: JSON.stringify({ type: 'run', run: { key: 'live', status: 'running', cwd: '/tmp/older-live' } }),
  }));
  stage='wait-sse-reorder';
  await page.waitForFunction(() => {
    const got = [...document.querySelectorAll('#projList .proj')]
      .map(el => decodeURIComponent(el.getAttribute('data-open')));
    return got[0] === '/tmp/mid-live' && got[1] === '/tmp/older-live' && got[2] === '/tmp/newer-idle';
  }, { timeout: 5000 });
  stage='assert-visible';
  reordered = await order();
  assert(await page.locator('[data-open="%2Ftmp%2Folder-live"]').isVisible(), 'running project visible');
  assert(await page.locator('.proj.go-live').count() === 2, 'both live projects highlighted');
  assert(errors.length === 0, errors.join('\n'));
  } catch (e) { throw new Error(`${stage}: ${e.message} | captured=${errors.join('; ')}`); }

  await page.screenshot({ path: 'output/playwright/remote-live-project-order.png' });
  return `PASS: starting/running projects pinned (${reordered.join(' -> ')}); no page errors. Viewer script + real browser, transport mocked.`;
}
