// Real TurnArticle + production CSS regression harness (Vite :5175).
// playwright-cli -s=msgactions open http://127.0.0.1:5175
// playwright-cli -s=msgactions run-code --filename tests/message-actions.browser.cjs
// Before-fix evidence: goto http://127.0.0.1:5175/?capture=before, then run the same harness.
async (page) => {
  const capture = /[?&]capture=before(?:&|$)/.test(page.url()) ? 'before' : 'after';
  const errors = [];
  const onError = error => errors.push(String(error));
  page.on('pageerror', onError);
  const url = `http://127.0.0.1:5175/message-actions-harness?capture=${capture}`;
  const route = route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' });
  await page.route(url, route);
  await page.goto(url);
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.evaluate(async () => {
    // Use Vite's optimized React URLs, not an independent React instance.
    const entry = await (await fetch('/main.tsx')).text();
    const React = (await import(entry.match(/"([^"\n]*\/react\.js\?[^"\n]*)"/)[1])).default;
    const { createRoot } = (await import(entry.match(/"([^"\n]*\/react-dom_client\.js\?[^"\n]*)"/)[1])).default;
    await import('/styles.css');
    await import('/replica/tokens.css');
    const { TurnArticle } = await import('/replica/chat/ChatView.tsx');
    await import('/replica/chat/chat.css');
    await import('/pi/replica-app.css');
    const h = React.createElement;
    const root = createRoot(document.getElementById('root'));
    window.clipboardWrites = [];
    window.editCalls = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.clipboardWrites.push(text); },
    } });
    const labels = {
      you: '你', assistant: '助手', simulatedRun: '模拟', toolRunning: '运行中', toolDone: '完成',
      toolError: '出错', working: '工作中', queued: '已排队', copyMessage: '复制', copied: '已复制',
      editMessage: '编辑并重发', resend: '重发', cancel: '取消', viewImage: '查看原图',
      downloadImage: '下载图片', close: '关闭', details: '详情',
    };
    const turn = (id, role, texts) => {
      const answer = texts.map((text, i) => ({ kind: 'text', id: `${id}-${i}`, text }));
      return { id, role, messageIds: [id], startedAt: 1, endedAt: 1001,
        segments: [{ kind: 'text', parts: answer }], steps: [], answer };
    };
    const long = turn('long', 'user', [
      '请修复聊天窗口中复制按钮和消息气泡底边重叠的问题。打开工作台后聊天列变窄，较长的中文消息会自动换行，按钮仍应在气泡下方靠右显示。',
      '鼠标悬停或键盘聚焦时显示操作，复制后也不要挡住正文或下一条消息。',
    ]);
    const single = turn('single', 'user', ['好']); // The copied label is wider than this bubble.
    const copyOnly = turn('copy-only', 'user', ['运行中只保留复制入口']);
    const image = { kind: 'image', id: 'image-part', mimeType: 'image/svg+xml', data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" fill="#a6bbcf"/></svg>') };
    const imageTurn = id => ({ id, role: 'user', messageIds: [id], startedAt: 1,
      segments: [{ kind: 'text', parts: [image] }], steps: [], answer: [image] });
    const turns = [long, turn('long-reply', 'assistant', ['已收到，先检查消息布局。']), single,
      turn('single-reply', 'assistant', ['下面这条回复也不能被操作按钮遮挡。']),
      copyOnly, turn('copy-only-reply', 'assistant', ['正在处理。']), imageTurn('image-edit'), imageTurn('image-only')];
    window.expectedTexts = Object.fromEntries([long, single, copyOnly].map(t => [t.id, t.answer.map(p => p.text).join('\n\n')]));
    window.renderMessages = ({ width, dark, zoom, caseId }) => root.render(
      h('main', { key: caseId, tabIndex: -1, 'data-case': caseId,
        className: `pireplica${dark ? ' pireplica--dark' : ''}`,
        style: { width, height: `${100 / zoom}vh`, zoom, margin: '0 auto' } },
      h('div', { className: 'pi-chat' }, h('div', { className: 'pi-chat__scroll' },
        h('div', { className: 'pi-chat__inner' }, turns.map(m => h(TurnArticle, {
          key: m.id, m, liveTurn: false, labels,
          onEditUser: ['copy-only', 'image-only'].includes(m.id) ? undefined : (id, text) => window.editCalls.push({ id, text }),
        })))))));
    window.measureImageAlign = id => {
      const article = document.querySelector(`[data-msg="${id}"]`);
      const a = article.getBoundingClientRect();
      const b = article.querySelector('.pi-msg__imagebtn');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { imgW: Math.round(r.width), gapRight: Math.round(a.right - r.right) };
    };
window.measureActions = id => {
      const article = document.querySelector(`[data-msg="${id}"]`);
      const row = article.querySelector('.pi-msg__actions');
      const copy = row.querySelector('[aria-label="复制"]');
      const rect = el => {
        const { top, right, bottom, left, width, height } = el.getBoundingClientRect();
        return { top, right, bottom, left, width, height };
      };
      const bubble = rect(article.querySelector('.pi-msg__bubble'));
      const actions = rect(row);
      const button = rect(copy);
      const next = rect(article.nextElementSibling);
      const style = getComputedStyle(row);
      const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const scroll = document.querySelector('.pi-chat__scroll');
      return { article: rect(article), bubble, actions, button, next,
        gap: actions.top - bubble.bottom,
        copyBubbleOverlapHeight: overlap(button, bubble) ? Math.min(button.bottom, bubble.bottom) - Math.max(button.top, bubble.top) : 0,
        copyBubbleOverlapArea: overlap(button, bubble), copyNextOverlapArea: overlap(button, next),
        actionsNextOverlapArea: overlap(actions, next), nextGap: next.top - actions.bottom,
        buttons: [...row.querySelectorAll('button')].map(rect),
        position: style.position, background: style.backgroundColor, shadow: style.boxShadow,
        opacity: Number(style.opacity), pointerEvents: style.pointerEvents,
        messageGap: getComputedStyle(article.parentElement).gap,
        rowScroll: row.scrollWidth, rowClient: row.clientWidth,
        chatScroll: scroll.scrollWidth, chatClient: scroll.clientWidth,
      };
    };
  });

  const failures = [];
  const lines = [];
  let checks = 0;
  const check = (ok, label) => { checks++; if (!ok) failures.push(label); };
  const measure = id => page.evaluate(id => window.measureActions(id), id);
  const waitOpacity = (id, visible) => page.waitForFunction(({ id, visible }) => {
    const row = document.querySelector(`[data-msg="${id}"] .pi-msg__actions`);
    return row && (visible ? Number(getComputedStyle(row).opacity) === 1 : Number(getComputedStyle(row).opacity) === 0);
  }, { id, visible });
  const stable = (a, b, label) => {
    for (const name of ['article', 'bubble', 'actions', 'button', 'next']) {
      check(['top', 'left', 'width', 'height'].every(key => Math.abs(a[name][key] - b[name][key]) < 0.5), `${label}: ${name} moved/resized`);
    }
  };
  const geometry = (m, zoom, label) => {
    check(m.position === 'static', `${label}: action row must be in normal flow, got ${m.position}`);
    check(Math.abs(m.gap - 6 * zoom) < 0.5, `${label}: expected 6px scaled gap, got ${m.gap.toFixed(2)}`);
    check(m.copyBubbleOverlapArea === 0, `${label}: copy overlaps bubble by ${m.copyBubbleOverlapHeight.toFixed(2)}px (${m.copyBubbleOverlapArea.toFixed(2)}px²)`);
    check(m.copyNextOverlapArea === 0 && m.actionsNextOverlapArea === 0 && m.nextGap >= 0, `${label}: actions overlap next message`);
    check(m.actions.top >= m.bubble.bottom && m.actions.bottom <= m.article.bottom + 0.5, `${label}: action row outside its article`);
    check(Math.abs(m.actions.right - m.bubble.right) < 0.5, `${label}: row not right-aligned to bubble`);
    check(m.actions.left >= m.article.left - 0.5 && m.actions.right <= m.article.right + 0.5, `${label}: row outside chat column`);
    check(m.buttons.every(b => b.left >= m.actions.left - 0.5 && b.right <= m.actions.right + 0.5 && b.top >= m.actions.top - 0.5 && b.bottom <= m.actions.bottom + 0.5), `${label}: button outside action row`);
    check(m.rowScroll <= m.rowClient + 1 && m.chatScroll <= m.chatClient + 1, `${label}: horizontal overflow`);
    check(m.shadow === 'none' && m.background === 'rgba(0, 0, 0, 0)', `${label}: floating background/shadow remains`);
    check(m.messageGap === '56px', `${label}: global message gap changed (${m.messageGap})`);
  };
  const hide = async id => {
    await page.mouse.move(2, 2);
    await page.evaluate(() => document.activeElement?.blur());
    await waitOpacity(id, false);
  };

  try {
    // Wide/narrow columns × light/dark × 85/100/125% CSS zoom; no action CSS overrides.
    for (const dark of [false, true]) for (const width of [860, 360]) for (const zoom of [1, 0.85, 1.25]) {
      const caseId = `${dark ? 'dark' : 'light'}-${width}-${Math.round(zoom * 100)}`;
      await page.evaluate(opts => window.renderMessages(opts), { width, dark, zoom, caseId });
      await page.locator(`[data-case="${caseId}"]`).waitFor();
      check(await page.locator('.pi-msg--assistant .pi-msg__actions').count() === 0, `${caseId}: assistant gained actions`);
      for (const id of ['long', 'single']) {
        const article = page.locator(`[data-msg="${id}"]`);
        const copy = article.getByRole('button', { name: '复制', exact: true });
        const edit = article.getByRole('button', { name: '编辑并重发', exact: true });
        await article.scrollIntoViewIfNeeded();
        await hide(id);
        const hidden = await measure(id);
        check(hidden.opacity === 0 && hidden.pointerEvents === 'none', `${caseId}/${id}: hidden row accepts pointer input`);
        await article.locator('.pi-msg__bubble').hover();
        await waitOpacity(id, true);
        const hovered = await measure(id);
        geometry(hovered, zoom, `${caseId}/${id}/hover`);
        stable(hidden, hovered, `${caseId}/${id}/hidden-to-hover`);
        check(hovered.pointerEvents === 'auto', `${caseId}/${id}: hover is not interactive`);
        lines.push(`MEASURE ${caseId}/${id}: gap=${hovered.gap.toFixed(2)} copyBubbleOverlapHeight=${hovered.copyBubbleOverlapHeight.toFixed(2)} copyBubbleOverlapArea=${hovered.copyBubbleOverlapArea.toFixed(2)} nextGap=${hovered.nextGap.toFixed(2)}`);
        if (caseId === 'light-860-100' && id === 'long') {
          // Save the reproducer even when the geometry assertions fail.
          await page.screenshot({ path: `output/playwright/message-actions-${capture}.png` });
        }
        await hide(id);
        stable(hidden, await measure(id), `${caseId}/${id}/hover-to-hidden`);
        if (id === 'long') {
          // Tab must reach an opacity:0 button (visibility:hidden/display:none would break this).
          await page.locator('main').focus();
          await page.keyboard.press('Tab');
        } else await copy.focus();
        await waitOpacity(id, true);
        check(await copy.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none'), `${caseId}/${id}: keyboard focus missing`);
        stable(hidden, await measure(id), `${caseId}/${id}/hidden-to-focus`);
        await hide(id);
        stable(hidden, await measure(id), `${caseId}/${id}/focus-to-hidden`);

        await article.locator('.pi-msg__bubble').hover();
        await waitOpacity(id, true);
        const writes = await page.evaluate(() => window.clipboardWrites.length);
        await copy.click(); // Real button + component handler; only the clipboard is stubbed.
        await article.locator('.pi-msg__action[title="已复制"]').waitFor();
        check(await page.evaluate(({ id, writes }) => window.clipboardWrites.length === writes + 1 && window.clipboardWrites[writes] === window.expectedTexts[id], { id, writes }), `${caseId}/${id}: clipboard content mismatch`);
        const copied = await measure(id);
        geometry(copied, zoom, `${caseId}/${id}/copied`);
        check(copied.actions.width > hovered.actions.width, `${caseId}/${id}: copied label did not expand`);
        check(Math.abs(copied.article.height - hovered.article.height) < 0.5 && Math.abs(copied.next.top - hovered.next.top) < 0.5, `${caseId}/${id}: copied label shifted next message`);
        if (caseId === 'dark-360-125' && id === 'single') await page.screenshot({ path: `output/playwright/message-actions-${capture}-dark-narrow-copied.png` });

        const editCount = await page.evaluate(() => window.editCalls.length);
        await edit.click();
        const textarea = article.locator('textarea');
        await textarea.waitFor();
        check(await textarea.inputValue() === await page.evaluate(id => window.expectedTexts[id], id), `${caseId}/${id}: edit draft mismatch`);
        check(await article.locator('.pi-msg__bubble, .pi-msg__actions').count() === 0, `${caseId}/${id}: edit did not replace bubble/actions`);
        await textarea.fill('未提交的修改');
        await article.getByRole('button', { name: '取消', exact: true }).click();
        await article.locator('.pi-msg__bubble').waitFor();
        check(await page.evaluate(() => window.editCalls.length) === editCount, `${caseId}/${id}: cancel submitted`);
        await article.locator('.pi-msg__bubble').hover();
        await edit.click();
        await textarea.waitFor();
        check(await textarea.inputValue() === await page.evaluate(id => window.expectedTexts[id], id), `${caseId}/${id}: cancel changed original text`);
        await textarea.press('Escape');
        await article.locator('.pi-msg__bubble').waitFor();
        check(await page.evaluate(() => window.editCalls.length) === editCount, `${caseId}/${id}: Escape submitted`);
      }
      const extra = await page.evaluate(() => ({
        copyOnly: [...document.querySelectorAll('[data-msg="copy-only"] .pi-msg__action')].map(el => el.getAttribute('aria-label')),
        images: ['image-edit', 'image-only'].map(id => {
          const article = document.querySelector(`[data-msg="${id}"]`);
          const row = article.querySelector('.pi-msg__actions');
          return { buttons: article.querySelectorAll('.pi-msg__action').length,
            rowHeight: row?.getBoundingClientRect().height || 0,
            extraHeight: article.getBoundingClientRect().height - article.querySelector('.pi-msg__imagebtn').getBoundingClientRect().height };
        }),
      }));
      check(JSON.stringify(extra.copyOnly) === '["复制"]', `${caseId}: running message should be copy-only`);
      check(extra.images.every(m => m.buttons === 0 && m.rowHeight === 0 && Math.abs(m.extraHeight) < 0.5), `${caseId}: image-only message gained an empty action row: ${JSON.stringify(extra.images)}`);
      // 用户图片必须右对齐且宽度 ≤320px（横长图曾因 max-width 百分比循环失效而超宽）
      const aligns = await page.evaluate(() => ['image-edit', 'image-only'].map(id => window.measureImageAlign(id)));
      check(aligns.every(m => m && m.gapRight === 0 && m.imgW <= 321), `${caseId}: user image right-aligned and ≤320px wide: ${JSON.stringify(aligns)}`);
    }

    // Verify the running/copy-only button and resend callback, then leave a visible hover screenshot.
    await page.evaluate(() => window.renderMessages({ width: 860, dark: false, zoom: 1, caseId: 'final' }));
    await page.locator('[data-case="final"]').waitFor();
    const copyOnly = page.locator('[data-msg="copy-only"]');
    await copyOnly.locator('.pi-msg__bubble').hover();
    await copyOnly.getByRole('button', { name: '复制', exact: true }).click();
    check(await page.evaluate(() => window.clipboardWrites.at(-1) === window.expectedTexts['copy-only']), 'copy-only clipboard content mismatch');
    const first = page.locator('[data-msg="long"]');
    await first.locator('.pi-msg__bubble').hover();
    await first.getByRole('button', { name: '编辑并重发', exact: true }).click();
    await first.locator('textarea').fill('  修改后的中文消息  ');
    await first.getByRole('button', { name: '重发', exact: true }).click();
    check(await page.evaluate(() => window.editCalls.length === 1 && window.editCalls[0].id === 'long' && window.editCalls[0].text === '修改后的中文消息'), 'resend callback changed');
    await hide('long');
    await first.locator('.pi-msg__bubble').hover();
    await waitOpacity('long', true);
    await page.screenshot({ path: `output/playwright/message-actions-${capture}.png` });
    check(errors.length === 0, `page errors: ${errors.join('\n')}`);
    if (failures.length) throw new Error(`FAIL: ${failures.length}/${checks} checks\n${lines.join('\n')}\n${failures.join('\n')}`);
    return `${lines.join('\n')}\nPASS: ${checks} checks; 12 layout configurations; real copy/edit/cancel/Escape/resend; hover/focus/hidden stable; image-only has no action space. Screenshots: output/playwright/message-actions-${capture}.png, output/playwright/message-actions-${capture}-dark-narrow-copied.png`;
  } finally {
    page.off('pageerror', onError);
    await page.unroute(url, route);
    // Keep the rendered page and visible actions for inspection, rather than unmounting it.
  }
}
