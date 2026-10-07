// 导航刻度悬浮提示（pi-rail__tip）回归：悬浮卡文字不得画出卡片边界。
// 历史 bug：tip 为 white-space:nowrap + 行内 em（inline 的 overflow:hidden 无效）→
// 长文本横向画出卡片、盖住消息正文。修复后 b 单行省略、em 两行钳制、卡片 ≤420px。
// Vite at :5175; playwright-cli run-code --filename tests/rail-tip.browser.cjs
async (page) => {
  const assert = (ok, label) => { if (!ok) throw new Error(label); };
  await page.route('http://127.0.0.1:5175/rail-tip', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('http://127.0.0.1:5175/rail-tip');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  await page.evaluate(async () => {
    await import('/pi/automations.css').catch(() => undefined); // 真实级联占位（无关本测试）
    await import('/replica/tokens.css');
    await import('/pi/replica-app.css');
    await import('/replica/chat/chat.css');
    document.getElementById('root').innerHTML = `
      <main class="pireplica" style="display:flex;height:100vh">
        <nav class="pi-rail" aria-label="Message navigation" style="position:relative;width:28px;flex:none">
          <div class="pi-rail__inner">
            <div class="pi-rail__slot"><button class="pi-rail__mark pi-rail__mark--user pi-rail__mark--active"></button></div>
          </div>
          <span class="pi-rail__tip" role="tooltip" style="top:120px">
            <b>希望加一个按月的聚合 想以一个月为一个尺度看人的消耗 也可以做对比，这个人、这个key、这个团队（聚合 gs）？确认后我按流程先登记定制（customizations…）</b>
            <em>1.103.1 这个版本我看着没啥问题了，准备发生产吧，先合并到 core 里面，今天 12-13 点之间发一个生产。发完所有用户要重新登录（v1.103.1 会话 token AES-GCM 安全变更，预期行为），顺便把部署脚本的验收标准（备份、切镜像、迁移、验证）都过一遍。</em>
          </span>
        </nav>
        <div style="flex:1"></div>
      </main>`;
  });
  await page.waitForTimeout(120);
  const m = await page.evaluate(() => {
    const tip = document.querySelector('.pi-rail__tip');
    const b = tip.querySelector('b');
    const em = tip.querySelector('em');
    const tipR = tip.getBoundingClientRect();
    // 用户的实际抱怨 = 文字画出卡片：直接量几何包含关系（视觉真值，绕开 display 计算值差异）
    const rel = (el) => ({
      right: +(el.getBoundingClientRect().right - tipR.right).toFixed(1),
      bottom: +(el.getBoundingClientRect().bottom - tipR.bottom).toFixed(1),
    });
    const bRel = rel(b), emRel = rel(em);
    return {
      tipWidth: Math.round(tipR.width),
      bRel, emRel,
      bEllipsis: getComputedStyle(b).textOverflow === 'ellipsis' && getComputedStyle(b).overflow === 'hidden',
      emClamp: getComputedStyle(em).webkitLineClamp,
    };
  });
  assert(m.tipWidth <= 421, `tip 宽度 ${m.tipWidth} 超 420`);
  assert(m.bRel.right <= 1, `question 右溢出 ${m.bRel.right}px`);
  assert(m.bRel.bottom <= 1, `question 下溢出 ${m.bRel.bottom}px`);
  assert(m.emRel.right <= 1, `summary 右溢出 ${m.emRel.right}px`);
  assert(m.emRel.bottom <= 1, `summary 下溢出 ${m.emRel.bottom}px`);
  assert(m.bEllipsis, 'question 未启用单行省略');
  console.log('RAIL TIP OK', JSON.stringify(m));
}
