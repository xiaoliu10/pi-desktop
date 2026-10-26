/**
 * Desktop cross-session handoff tool.
 *
 * 当会话 A 的排查/工作需要在**另一个项目**的既有会话 B 里继续时（项目级记忆、
 * MCP、权限相互隔离），通过保留 title 的 ui.input 载荷把交接请求交给 Desktop
 * 主进程：主进程按项目找到「未归档、最近活跃」的会话，连着就立即/排队投递，
 * 没连着就重连该会话后投递。绝不新建独立会话，绝不跨项目乱选。
 *
 * 应答走常规 extension_ui_response 通道（主进程异步应答，含目标会话与投递结果）。
 */
export default function desktopHandoff(pi) {
  pi.registerTool({
    name: 'desktop_handoff',
    label: '会话交接',
    description: [
      'Hand a self-contained task/findings to an EXISTING session in another project (project memory/MCP/permissions stay isolated with that session).',
      'Use when work found in this session must continue in a different repository/project that already has a responsible session, e.g. 「这个根因交给 ccr 那边的会话修」.',
      'Do NOT use for: work in the current project (just continue here), immediate execution in a fresh session (desktop_schedule is for later; normal chat is for now), or merely telling the user something.',
      'Default targeting: Desktop reuses the target project\'s most recently active, non-archived, non-sidecar session; if that session is busy the message is queued behind its current turn; if it is disconnected Desktop reconnects it first.',
      'action:"list" first when unsure which session exists (pass projectPath); action:"send" delivers. Parameters: projectPath (absolute path, required for a different project; defaults to this project), sessionKey (optional explicit target from list), message (1-20000 chars, SELF-CONTAINED: findings, evidence, file paths, acceptance criteria — the target session did not see this conversation), idempotencyKey (stable string for retries to prevent double delivery).',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['send', 'list'] },
        projectPath: { type: 'string', maxLength: 4096, description: '目标项目的绝对路径；list/send 另一个项目时必填' },
        sessionKey: { type: 'string', description: '显式指定目标会话 key（来自 action=list）；省略则选该项目最近活跃的未归档会话' },
        message: { type: 'string', maxLength: 20000, description: '自包含交接内容：结论、证据、相关文件路径、验收标准；目标会话没有当前对话上下文' },
        idempotencyKey: { type: 'string', maxLength: 200, description: '稳定幂等键：重试/并行重复调用同一交接只投递一次' },
      },
    },
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      const cancelled = { content: [{ type: 'text', text: '已取消，未交接。' }], details: { cancelled: true } };
      if (signal?.aborted) return cancelled;
      const reply = await ctx.ui.input('desktop-handoff', JSON.stringify({ v: 1, ...args }));
      if (reply === undefined || ctx?.signal?.aborted) return cancelled;
      let result;
      try { result = JSON.parse(reply); } catch { return { content: [{ type: 'text', text: 'Desktop 返回了无法解析的结果，请重试。' }] }; }
      if (!result?.ok) return { content: [{ type: 'text', text: `会话交接失败：${result?.error ?? '未知错误'}` }], details: result };
      if (result.action === 'list') {
        const sessions = Array.isArray(result.sessions) ? result.sessions : [];
        if (!sessions.length) return { content: [{ type: 'text', text: `目标项目下没有可复用的未归档会话（${args.projectPath ?? '当前项目'}）。可让用户先在该项目打开一个会话，或确认项目路径。` }], details: result };
        const lines = sessions.map((s, i) => `${i + 1}. ${s.name || s.key}${s.connected ? `（${s.status === 'running' ? '运行中，将排队' : '已连接，空闲'}）` : '（未连接，将重连）'} key=${s.key}`);
        return { content: [{ type: 'text', text: `目标项目可选会话：\n${lines.join('\n')}\n用 action:"send" + sessionKey 交接；省略 sessionKey 则选最近活跃的第 1 个。` }], details: result };
      }
      const t = result.target ?? {};
      const disposition = { started: '已开始执行', queued: '目标会话运行中，已排队', reconnected: '已重连目标会话并开始执行' }[t.disposition] || t.disposition;
      return {
        content: [{ type: 'text', text: result.duplicate ? `该交接此前已投递（幂等），目标会话：${t.sessionName || t.key}，${disposition}。` : `已交接给目标会话「${t.sessionName || t.key}」：${disposition}。后续在该会话（项目内）继续，本会话不代为执行。` }],
        details: result,
      };
    },
  });
}
