/**
 * Desktop scheduled-task tool: ZCode-style CronCreate.
 *
 * 会话内「今晚 22:00 发版」「每天早上 9 点检查」这类请求，靠对话承诺没有任何
 * 机制兜底（会话一断承诺就没了）。这个工具把请求编码进保留 title 的 ui.input
 * 载荷，Desktop 主进程拦截后写入调度器（automations.json），到点由 Desktop 拉
 * 起全新会话执行——即使当前会话早已结束。应答走常规 extension_ui_response 通道。
 */

function normalizeSchedule(input) {
  if (!input || typeof input !== 'object') throw new Error('schedule 缺失：需要 {kind:"once",at} / {kind:"interval",minutes} / {kind:"cron",expression}');
  if (input.kind === 'once') {
    const at = typeof input.at === 'string' ? Date.parse(input.at) : Number(input.at);
    if (!Number.isFinite(at)) throw new Error('once 需要有效时间（ISO 8601 字符串或毫秒时间戳）');
    if (at <= Date.now() + 30000) throw new Error('一次性任务的执行时间必须在未来（至少 30 秒后）；立即要做的事直接执行，不要建任务');
    return { kind: 'once', at };
  }
  if (input.kind === 'interval') {
    const minutes = Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error('interval 需要 1–525600 的整数分钟');
    return { kind: 'interval', minutes };
  }
  if (input.kind === 'cron') {
    const expression = String(input.expression ?? '').trim();
    if (expression.split(/\s+/).length !== 5) throw new Error('cron 需要 5 段表达式（分 时 日 月 周，本地时区）');
    return { kind: 'cron', expression };
  }
  throw new Error('schedule.kind 只支持 once / interval / cron');
}

export default function desktopSchedule(pi) {
  pi.registerTool({
    name: 'desktop_schedule',
    label: '定时任务',
    description: [
      'Create, list, or cancel Desktop scheduled tasks that run LATER in a brand-new session.',
      'Use this whenever the user asks for work at a specific time or on a repeating schedule (e.g. 「今晚 22:00 发布」, 「每天早上 9 点检查」, 「10 分钟后提醒我」).',
      'The task is persisted by Desktop and survives this conversation ending; even a verbal promise in conversation does not.',
      'Rules: action=create needs name (short title), prompt (SELF-CONTAINED instructions — the task runs in a fresh session with NO memory of this conversation, so include repo paths, commands and acceptance criteria), and schedule: {kind:"once", at: ISO string or epoch ms} | {kind:"interval", minutes: 1-525600} | {kind:"cron", expression: 5-field, local timezone}.',
      'Optional permission "ask"|"autoedit"|"full" defaults to this session\'s and is capped at it; unattended tasks that must run tools need full access or they will stall on approval dialogs.',
      'action=list takes no arguments; action=cancel needs the task id from list.',
      'Never use this for work that should happen right now.',
    ].join(' '),
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'], description: 'create=新建任务，list=列出任务，cancel=删除任务' },
        name: { type: 'string', maxLength: 100, description: '任务名称（create）' },
        prompt: { type: 'string', maxLength: 20000, description: '任务指令（create）：给全新会话的自包含任务书' },
        schedule: {
          type: 'object', description: '调度规则（create）',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['once', 'interval', 'cron'] },
            at: { type: 'string', description: 'once：ISO 8601 时间或毫秒时间戳' },
            minutes: { type: 'number', description: 'interval：间隔分钟数' },
            expression: { type: 'string', description: 'cron：五段表达式（本地时区）' },
          },
        },
        permission: { type: 'string', enum: ['ask', 'autoedit', 'full'], description: '任务会话的访问模式（默认继承当前会话，且不会高于它）' },
        id: { type: 'string', description: '任务 id（cancel，来自 list）' },
      },
    },
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      const cancelled = { content: [{ type: 'text', text: '已取消，未创建定时任务。' }], details: { cancelled: true } };
      if (signal?.aborted) return cancelled;
      let schedule;
      if (args?.action === 'create') schedule = normalizeSchedule(args.schedule);
      const reply = await ctx.ui.input('desktop-automation', JSON.stringify({ v: 1, ...args, schedule }));
      if (reply === undefined || ctx?.signal?.aborted) return cancelled;
      let result;
      try { result = JSON.parse(reply); } catch { return { content: [{ type: 'text', text: 'Desktop 返回了无法解析的结果，请重试。' }] }; }
      if (!result?.ok) return { content: [{ type: 'text', text: `定时任务操作失败：${result?.error ?? '未知错误'}` }], details: result };
      if (result.action === 'create') {
        const when = result.task?.nextRunAt ? new Date(result.task.nextRunAt).toLocaleString() : '调度器计算的时间';
        return { content: [{ type: 'text', text: `已创建定时任务「${result.task.name}」，下次执行 ${when}。届时 Desktop 会用全新会话执行任务指令（不含当前对话上下文）。` }], details: result.task };
      }
      if (result.action === 'cancel') return { content: [{ type: 'text', text: '已删除定时任务。' }] };
      return { content: [{ type: 'text', text: `当前共有 ${result.tasks?.length ?? 0} 个定时任务：\n${(result.tasks ?? []).map(t => `- ${t.name}${t.enabled ? '' : '（已停用）'}`).join('\n') || '（无）'}` }], details: { tasks: result.tasks } };
    },
  });
}
