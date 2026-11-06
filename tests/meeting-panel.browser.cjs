// Mock media + meeting IPC only. Vite at :5175; playwright-cli -s=meeting run-code --filename tests/meeting-panel.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/meeting-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/meeting-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { MeetingPanel } = await import('/pi/MeetingPanel.tsx');
    const { WorkbenchPanel } = await import('/replica/workbench/WorkbenchPanel.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css'); await import('/replica/workbench/workbench.css');
    const root = createRoot(document.getElementById('root'));

    // Tiny controllable MediaRecorder: every recorder auto-finishes after one tick.
    window.calls = { media: 0, recorders: 0, appended: [], started: [], stop: 0, stopAfterAppends: null, released: 0 };
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; window.calls.recorders++; window.recorder = this; }
      start() { this.state = 'recording'; setTimeout(() => { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([`audio-${window.calls.recorders}`]) }); this.onstop?.(); }, 20); }
      stop() { if (this.state === 'recording') { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob([`audio-final-${window.calls.recorders}`]) }); this.onstop?.(); }, 5); } }
    };
    window.AudioContext = class {
      async decodeAudioData() { return { numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array(1600) }; }
      async close() {}
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => window.calls.released++ }] }) } });
    const baseMeeting = {
      version: 1, id: 'meeting-1', title: '测试会议', createdAt: '2026-11-06T09:00:00.000Z', updatedAt: '2026-11-06T09:00:00.000Z',
      status: 'recording', captureEpochs: [{ epoch: 1, startedAt: '2026-11-06T09:00:00.000Z', reason: 'start' }],
      segments: [], coverage: { capturedMs: 0, transcribedMs: 0, emptyMs: 0, missingMs: 0 }, minutes: { status: 'idle' },
    };
    const segment = index => ({
      id: `server-${index}`, clientSegmentId: `client-${index}`, index: index - 1, captureEpoch: 1,
      startOffsetMs: (index - 1) * 50, endOffsetMs: index * 50,
      wallStartedAt: '2026-11-06T09:00:00.000Z', wallEndedAt: '2026-11-06T09:00:01.000Z',
      mime: 'audio/wav', audioPath: `/tmp/seg-${index}.wav`, bytes: 10, sha256: 'hash',
      status: 'done', failureKind: 'none', attempt: 1, text: `分段${index}内容`,
    });
    const meetingWith = index => ({ ...baseMeeting, segments: Array.from({ length: index }, (_, i) => segment(i + 1)) });
    window.localPi = {
      voiceConfig: async () => ({ activeId: 'asr', models: [{ id: 'asr', ready: true }] }),
      meetingCreate: async input => ({ ...baseMeeting, title: input.title }),
      meetingAppendSegment: async (id, clientSegmentId, bytes, meta) => {
        window.calls.started.push(clientSegmentId);
        // 第一段持久化慢、最后一段快：stop 必须等慢段，否则会被主进程拒绝。
        await new Promise(resolve => setTimeout(resolve, clientSegmentId.includes('-client-2-') ? 0 : 5000));
        window.calls.appended.push({ id, clientSegmentId, bytes: bytes.length, meta });
        const index = window.calls.appended.length;
        return { meeting: meetingWith(index), segment: segment(index), duplicated: false };
      },
      meetingStop: async id => { window.calls.stop++; window.calls.stopAfterAppends = window.calls.appended.length; return { ...meetingWith(window.calls.appended.length), status: 'processing' }; },
      meetingGet: async id => meetingWith(window.calls.appended.length),
      meetingGenerateMinutes: async (id, input) => ({ ...meetingWith(window.calls.appended.length), status: 'ready', minutes: { status: 'done', provider: input.provider, model: input.model, path: '/minutes.md', mappedChunks: 1, completedChunks: 1 } }),
    };
    const labels = {
      review: '变更', files: '文件', browser: '浏览器', auxiliary: '辅助对话', meeting: '会议',
      homeTitle: '要打开哪个功能？', homeReview: '', homeFiles: '', homeBrowser: '', homeAuxiliary: '', homeMeeting: '录制并生成纪要', close: '关闭面板',
      emptyReview: '', emptyReviewHint: '', emptyFiles: '', emptyFilesHint: '', emptyBrowser: '', emptyBrowserHint: '', created: '', selectFile: '',
    };
    let selectedTab = 'home';
    function WorkbenchHarness() {
      const [tab, setTab] = React.useState(selectedTab);
      return React.createElement(WorkbenchPanel, {
        open: true, tab, diffs: [], files: [], selectedFile: null, demo: false, labels,
        meetingPanel: React.createElement(MeetingPanel),
        onToggle() {}, onSelectTab(next) { selectedTab = next; setTab(next); }, onSelectFile() {},
      });
    }
    window.render = view => root.render(view === 'workbench' ? React.createElement(WorkbenchHarness) : React.createElement(MeetingPanel));
  });
  await page.evaluate(() => window.render('panel'));
  const start = page.getByRole('button', { name: '开始录音', exact: true });
  await start.click();
  await page.evaluate(() => window.stage = 'started');
  await page.getByText('00:00', { exact: false }).waitFor();
  await page.waitForFunction(() => window.calls.started.length >= 1 && window.calls.recorders >= 2);
  // 同步点击：第一段还在 persistence，第二段更快；验证 stop 不会越过旧段。
  await page.evaluate(() => document.querySelector('.meeting-danger').click());
  await page.waitForFunction(() => window.calls.stop === 1);
  await page.waitForFunction(() => (
    window.calls.appended.length >= 2
    && window.calls.appended.length === window.calls.stopAfterAppends
    && window.calls.released >= 1
  ));
  await page.evaluate(() => window.stage = 'final-segment-saved');
  assert(await page.evaluate(() => window.calls.appended[0].meta.mime === 'audio/wav'), 'segment is normalized to wav');
  await page.getByText('分段1内容').waitFor();
  await page.evaluate(() => window.stage = 'transcript-visible');
  await page.getByText('正在整理', { exact: true }).waitFor();
  await page.evaluate(() => window.stage = 'stopped');
  assert(await page.evaluate(() => window.calls.stopAfterAppends === window.calls.appended.length), 'stop waits for every pending segment before meetingStop');

  // A second explicit click does not restart the same recording after stop.
  const recorderCount = await page.evaluate(() => window.calls.recorders);
  assert(!(await page.getByRole('button', { name: '开始录音', exact: true }).isVisible()), 'start button stays hidden until user starts a new meeting');
  assert(await page.evaluate(n => window.calls.recorders === n, recorderCount), 'stopped meeting does not spawn recorders');

  await page.evaluate(() => window.render('workbench'));
  await page.evaluate(() => window.stage = 'workbench-rendered');
  await page.getByRole('tab', { name: '会议' }).waitFor();
  await page.evaluate(() => window.stage = 'meeting-tab-visible');
  await page.getByRole('button', { name: /会议/ }).last().click();
  await page.evaluate(() => window.stage = 'meeting-card-clicked');
  await page.waitForFunction(() => document.querySelector('[data-meeting-panel="true"]'));
  assert(errors.length === 0, errors.join('\n'));
  await page.screenshot({ path: 'output/playwright/meeting-panel.png' });
  return 'PASS: meeting card/tab entry; segmented capture; wav append; stop/finalize; keep-alive panel; no recorder leak after stop. Mock only.';
}
