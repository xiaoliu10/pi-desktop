/** Tool-call policy; trusted extension Node code is outside this boundary. */
import fs from 'node:fs';
import { registerDesktopPlan } from './plan.mjs';
import { classify, approvalMessage, approvalMeta, fileRevision, inputDigest, modes } from './policy.mjs';
export default function desktopPolicy(pi) {
  registerDesktopPlan(pi);
  const labels = { plan: '计划模式', ask: '变更前确认', autoEdit: '自动编辑', fullAccess: '完全访问' };
  let mode = process.env.PI_DESKTOP_PERMISSION || 'ask';
  if (!modes.includes(mode)) throw new Error('未知 Desktop 访问模式');
  // Desktop may switch the mode mid-run by rewriting this control file; we
  // poll it per tool call (cheap, cached by mtime) instead of requiring a
  // process restart, which is only possible while the session is idle.
  const modeFile = process.env.PI_DESKTOP_MODE_FILE || '';
  let modeCache = { mtimeMs: -1, mode };
  const readModeFile = () => {
    if (!modeFile) return mode;
    try {
      const stat = fs.statSync(modeFile);
      if (stat.mtimeMs === modeCache.mtimeMs) return modeCache.mode;
      const next = fs.readFileSync(modeFile, 'utf8').trim();
      if (!modes.includes(next)) return modeCache.mode;
      modeCache = { mtimeMs: stat.mtimeMs, mode: next };
      if (next !== mode) {
        pi.appendEntry('desktop-policy-audit', { at: Date.now(), mode: next, type: 'mode-change', reason: 'Desktop 运行中切换' });
        mode = next;
      }
      return mode;
    } catch { return modeCache.mode; }
  };
  const builtin = name => pi.getAllTools().find(t => t.name === name)?.sourceInfo?.source === 'builtin';
  const audit = data => pi.appendEntry('desktop-policy-audit', { at: Date.now(), mode: readModeFile(), ...data });
  // 权限审批五选项（ZCode 同款）：响应值经 RPC select 直传，自定义指引文字不在此列。
  const PERMISSION_OPTIONS = ['允许', '始终允许本项目', '完全访问', '拒绝', '告诉模型接下来应该怎么做'];
  // 「始终允许本项目」的会话级记忆：key = 工具：目标路径；会话结束即失效（不继承历史审批）。
  const approvedTargets = new Set();
  const setMode = next => {
    if (modeFile) { try { fs.writeFileSync(modeFile, next); } catch { /* 写失败则仅内存切换 */ } }
    mode = next;
    modeCache = { mtimeMs: -1, mode: next };
  };
  pi.on('session_start', (_event, ctx) => {
    if (mode === 'plan') pi.setActiveTools([...pi.getActiveTools().filter(name => ['read', 'grep', 'find', 'ls'].includes(name) && builtin(name)), 'desktop_update_plan']);
    audit({ type: 'mode', reason: 'Desktop 启动策略；不继承历史审批' });
    ctx.ui.setStatus('desktop-policy', `工具权限：${labels[mode]}`);
  });
  pi.on('before_agent_start', event => {
    const current = readModeFile();
    return { systemPrompt: event.systemPrompt + '\nFor multi-step work use desktop_update_plan to maintain a concise checklist and update it as progress changes. Never mark unverified work completed.' + (current === 'plan'
      ? '\nDesktop 当前为计划模式。只研究项目并给出实施计划，不修改文件、不执行命令、不调用有副作用的工具。完成计划后等待用户点击“按计划执行”。'
      : `\nDesktop 访问模式：${labels[current]}。被策略拒绝时说明原因，不要通过其他工具绕过权限。`) };
  });
  pi.on('tool_call', async (event, ctx) => {
    const current = readModeFile();
    if (ctx.ui) ctx.ui.setStatus('desktop-policy', `工具权限：${labels[current]}`);
    const block = reason => { audit({ type: 'tool', tool: event.toolName, callId: event.toolCallId, decision: 'deny', reason }); return { block: true, reason }; };
    if (ctx.signal?.aborted) return block('运行已取消');
    if (event.toolName === 'desktop_update_plan') return; // metadata-only tool registered above
    const decision = classify({ mode: current, tool: event.toolName, input: event.input, cwd: ctx.cwd, builtin: builtin(event.toolName) });
    if (decision.action === 'deny') return block(decision.reason);
    if (decision.action === 'ask') {
      const targetKey = decision.target ? `${event.toolName}:${decision.target}` : '';
      if (targetKey && approvedTargets.has(targetKey)) {
        audit({ type: 'tool', tool: event.toolName, callId: event.toolCallId, decision: 'allow', reason: '本会话已批准相同目标（始终允许本项目）' });
        return;
      }
      const digest = inputDigest(event.input);
      try {
        const revision = fileRevision(decision.target);
        // ZCode 同款五选项：允许 / 始终允许本项目 / 完全访问 / 拒绝 / 自定义指引文字。
        // RPC select 无 message 通道：工具行元数据与 diff 文档编码在 title 内，由渲染端解析。
        const title = [
          `Desktop 审批 · ${event.toolName}`,
          '[pi-desktop-meta]' + JSON.stringify(approvalMeta(event, decision, ctx.cwd)),
          '[pi-desktop-message]' + approvalMessage(event, decision, ctx.cwd),
        ].join('\n');
        const choice = await ctx.ui.select(title, PERMISSION_OPTIONS, { signal: ctx.signal });
        if (choice === undefined || ctx.signal?.aborted) return block('用户拒绝或运行已取消');
        if (!PERMISSION_OPTIONS.includes(choice)) return block(choice); // 自定义指引：原因回传给模型
        if (choice === '拒绝') return block('用户拒绝本次操作');
        if (choice === '告诉模型接下来应该怎么做') return block('用户未批准本次操作'); // 无文字时按拒绝处理
        if (choice === '始终允许本项目' && targetKey) approvedTargets.add(targetKey);
        if (choice === '完全访问') {
          setMode('fullAccess');
          audit({ type: 'mode', reason: '审批中选择完全访问' });
        }
        const after = readModeFile();
        if (after === 'fullAccess') { audit({ type: 'tool', tool: event.toolName, callId: event.toolCallId, decision: 'allow', reason: choice === '完全访问' ? '审批中切换为完全访问' : '审批期间切换为完全访问' }); return; }
        const currentAfter = classify({ mode: after, tool: event.toolName, input: event.input, cwd: ctx.cwd, builtin: builtin(event.toolName) });
        if (inputDigest(event.input) !== digest || currentAfter.target !== decision.target || currentAfter.action !== 'ask' || fileRevision(currentAfter.target) !== revision) return block('审批期间参数、文件或权限发生变化，请重新发起工具调用');
        audit({ type: 'tool', tool: event.toolName, callId: event.toolCallId, decision: 'allow', reason: choice === '始终允许本项目' ? '已加入本会话目标记忆' : currentAfter.reason });
        return;
      } catch (e) { return block(`无法核对审批：${e.message}`); }
    }
    audit({ type: 'tool', tool: event.toolName, callId: event.toolCallId, decision: 'allow', reason: decision.reason });
  });
}
