// Mock media + IPC only. Vite at :5175; playwright-cli run-code --filename tests/voice-input.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://127.0.0.1:5175/voice-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/voice-test');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    const { VoiceInputButton } = await import('/pi/VoiceInputButton.tsx');
    const { Composer } = await import('/replica/chat/ChatView.tsx');
    await import('/replica/tokens.css'); await import('/replica/chat/chat.css');
    const root = createRoot(document.getElementById('root'));
    window.mode = 'ok'; window.calls = { media: 0, stop: 0, transcribe: 0, config: 0 }; window.notConfigured = 0; window.messages = [];
    const stream = () => ({ getTracks: () => [{ stop: () => window.calls.stop++ }] });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      window.calls.media++;
      if (window.mode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
      if (window.mode === 'slow') return new Promise(resolve => window.allow = () => resolve(stream()));
      return stream();
    } } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { if (window.mode === 'constructor') throw new Error('mock constructor failure'); this.state = 'inactive'; this.mimeType = 'audio/webm'; window.rec = this; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(window.mode === 'empty' ? [] : ['synthetic']) }); this.onstop?.(); }); }
    };
    window.localPi = {
      voiceConfig: async () => { window.calls.config++; if (window.mode === 'checking') await new Promise(r => window.checked = r); return { activeId: 'a', models: window.mode === 'none' ? [] : [{ id: 'a', ready: window.mode !== 'inactive' }, { id: 'b', ready: true }] }; },
      voiceTranscribe: async () => { window.calls.transcribe++; if (window.mode === 'failure') throw new Error('mock IPC failure'); if (window.mode === 'late') return new Promise(r => window.transcribed = r); return window.mode === 'blank' ? '  ' : '转写文本'; },
    };
    const labels = { voiceStart: '开始录音', voiceStop: '停止录音', voiceTranscribing: '正在转写', placeholderSession: '草稿', placeholderHome: '草稿', send: '发送', stop: '停止' };
    function Harness({ session }) {
      const [draft, setDraft] = React.useState('');
      return React.createElement(Composer, { draftText: draft, onDraftChange: value => { window.draft = value; setDraft(value); }, labels, modelId: '', modelGroups: [], slashCommands: [], files: [], queue: [], reasoning: 'off', agentMode: 'agent', permissionMode: 'ask', sessionActive: true, onSend() {},
        voiceSlot: append => React.createElement(VoiceInputButton, { key: session, labels, zh: true, onTranscript: append, onError: text => window.messages.push(text), onNotConfigured: () => window.notConfigured++ }) });
    }
    window.render = session => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness, { session })));
    window.clear = () => root.render(null);
    // Exact old mountedRef effect pattern demonstrates StrictMode replay, without using a microphone.
    function LegacyProbe() { const mounted = React.useRef(true); React.useEffect(() => () => { mounted.current = false; }, []); React.useEffect(() => { window.legacyMounted = mounted.current; }); return null; }
    root.render(React.createElement(React.StrictMode, null, React.createElement(LegacyProbe)));
  });
  await page.waitForFunction(() => window.legacyMounted === false);
  await page.evaluate(() => window.render('a'));
  const start = page.getByRole('button', { name: '开始录音', exact: true });
  const stop = page.getByRole('button', { name: '停止录音', exact: true });
  await start.click(); await stop.waitFor();
  // Input and stop within the same JS task, before the 200ms debounce can flush.
  await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '本地草稿');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[aria-label="停止录音"]').click();
    document.querySelector('.pi-composer__voice').click();
  });
  await page.waitForFunction(() => window.draft === '本地草稿 转写文本');
  await page.waitForTimeout(250);
  assert(await page.locator('textarea').inputValue() === '本地草稿 转写文本', 'debounce preserves transcript and local draft');
  assert(await page.evaluate(() => window.calls.transcribe === 1 && window.calls.media === 1 && window.calls.stop === 1), 'single stop/transcription and track release');
  for (const mode of ['none', 'inactive', 'denied', 'constructor', 'empty', 'blank', 'failure']) {
    await page.evaluate(m => { window.mode = m; window.messages = []; }, mode);
    const before = await page.evaluate(() => ({ ...window.calls, notConfigured: window.notConfigured }));
    await start.click();
    if (['empty', 'blank', 'failure'].includes(mode)) { await stop.click(); }
    await start.waitFor();
    if (['none', 'inactive'].includes(mode)) {
      await page.waitForFunction(n => window.notConfigured > n, before.notConfigured);
      assert(await page.evaluate(n => window.calls.media === n, before.media), 'unready active model blocks microphone');
    } else {
      await page.waitForFunction(() => window.messages.length === 1);
      if (mode === 'denied') assert(await page.evaluate(() => window.messages[0].includes('权限被拒绝')), 'permission help');
      if (mode !== 'denied') assert(await page.evaluate(n => window.calls.stop === n + 1, before.stop), mode + ' releases track');
    }
  }
  for (const mode of ['checking', 'slow']) {
    await page.evaluate(m => window.mode = m, mode);
    await start.click();
    await page.getByRole('status').filter({ hasText: mode === 'checking' ? '检查' : '权限' }).waitFor();
    assert(await page.locator('.pi-composer__voice').isDisabled(), mode + ' disables re-entry');
    const before = await page.evaluate(() => ({ ...window.calls }));
    await page.screenshot({ path: `output/playwright/voice-${mode}.png` });
    await page.evaluate(() => { document.querySelector('.pi-composer__voice').click(); window.clear(); });
    await page.locator('.pi-composer__voice').waitFor({ state: 'detached' });
    await page.evaluate(m => m === 'checking' ? window.checked() : window.allow(), mode);
    await page.waitForTimeout(50);
    assert(await page.evaluate(([m, b]) => m === 'checking' ? window.calls.media === b.media : window.calls.stop === b.stop + 1, [mode, before]), 'late async cleanup');
    await page.evaluate(() => window.render('a')); await start.waitFor();
  }
  await page.evaluate(() => window.mode = 'ok');
  const beforeDouble = await page.evaluate(() => window.calls.config);
  await page.evaluate(() => { const b = document.querySelector('.pi-composer__voice'); b.click(); b.click(); });
  await stop.waitFor();
  assert(await page.evaluate(n => window.calls.config === n + 1, beforeDouble), 'synchronous double-start guarded');
  const beforeError = await page.evaluate(() => window.calls.stop);
  await page.evaluate(() => { window.messages = []; window.rec.onerror(); });
  await start.waitFor();
  assert(await page.evaluate(n => window.calls.stop === n + 1 && window.messages.length === 1, beforeError), 'recorder error releases stream');
  await start.click(); await stop.waitFor();
  const beforeUnmount = await page.evaluate(() => window.calls.stop);
  await page.evaluate(() => window.clear());
  await page.waitForFunction(n => window.calls.stop === n + 1, beforeUnmount);
  await page.evaluate(() => { window.mode = 'late'; window.render('a'); });
  await start.click(); await stop.click(); await page.waitForFunction(() => !!window.transcribed);
  await page.evaluate(() => window.render('b')); await start.waitFor();
  await page.evaluate(() => window.transcribed('不得写入新会话'));
  await page.waitForTimeout(250);
  assert(!(await page.locator('textarea').inputValue()).includes('不得'), 'session switch discards late transcript');
  assert(errors.length === 0, errors.join('\n'));
  await page.screenshot({ path: 'output/playwright/voice-input.png' });
  return 'PASS: legacy StrictMode reproduction; fixed StrictMode recording→draft; debounce; active-model gate; permission denial; constructor/empty audio/empty result/IPC failures; single stop; visible checking/requesting; late permission/config cleanup; recording unmount; session switch during transcription. Mock only.';
}
