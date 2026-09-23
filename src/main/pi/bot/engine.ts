/**
 * Bot command engine — pure and channel-agnostic. Parses /commands plus free
 * text and executes them against a BotActions facade implemented by the host.
 * Mirrors the command surface users know from the reference bot:
 * /帮助 /状态 /新建 /clear /项目 /模型 /模式 /思考 /回复 /bind.
 */

export interface BotBinding {
  /** Bound project directory (workspace). */
  cwd?: string;
  /** Chat-level input-strategy choice (排队追问 / 调整当前任务). */
  mode?: string;
}

export interface BotActions {
  status(cwd?: string): Promise<string>;
  listProjects(): Promise<string[]>;
  listModels(cwd?: string): Promise<string[]>;
  switchModel(index: number, cwd?: string): Promise<string>;
  /** Create a fresh session in the bound (or only) workspace. */
  newTask(cwd?: string): Promise<string>;
  setThinking(level: string): Promise<string>;
  /** Send free text into the workspace's live session. */
  prompt(text: string, cwd?: string): Promise<string>;
  modes(): string[];
  setMode(mode: string): Promise<string>;
  thinkingLevels(): string[];
  /** Model id → whether free-text prompting may run (permission gate). */
  promptAllowed(): boolean;
}

export const HELP_TEXT = [
  'PI Desktop 机器人命令：',
  '/帮助 — 查看这份说明',
  '/状态 — 查看工作区、模型和任务状态',
  '/新建 或 /clear — 在工作区开始新的任务',
  '/项目 — 列出工作区；/项目 <名称> 切换绑定',
  '/模型 — 列出模型；/模型 <序号> 切换模型',
  '/模式 — 切换输入策略（排队追问 / 调整当前任务）',
  '/思考 — 切换思考级别；/思考 <级别> 直接设置',
  '/回复 — 回复详细程度暂不支持',
  '/bind — 把当前聊天绑定到最近使用的会话',
  '直接发文字 = 发送到当前任务（运行中排队，空闲则提示）。',
].join('\n');

export function parseCommand(input: string): { cmd: string; args: string } {
  const trimmed = input.trim();
  const match = /^\/([a-zA-Z\u4e00-\u9fa5]+)(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (!match) return { cmd: '', args: '' };
  return { cmd: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Handle one message; bindings map chatId → project cwd. Mutates bindings. */
export async function handleMessage(
  input: string,
  chatId: string,
  bindings: Record<string, BotBinding>,
  actions: BotActions,
): Promise<string> {
  const { cmd, args } = parseCommand(input);
  const binding = bindings[chatId] ?? {};
  if (!cmd) {
    // Free text goes to the live session of the bound workspace.
    if (!binding.cwd) return '尚未绑定工作区：发送 /bind 绑定最近的会话，或 /项目 查看列表。';
    if (!actions.promptAllowed()) return '当前会话权限不允许远程输入（连接时未开启允许工具调用/输入）。';
    return actions.prompt(input.trim(), binding.cwd);
  }
  switch (cmd) {
    case '帮助':
    case 'help':
      return HELP_TEXT;
    case 'bind': {
      const projects = await actions.listProjects();
      if (!projects.length) return '还没有可用的工作区会话。先在桌面端新建一个会话。';
      bindings[chatId] = { cwd: projects[0] };
      return `已绑定到最近的工作区：${baseName(projects[0])}`;
    }
    case '项目':
    case 'workspace': {
      const projects = await actions.listProjects();
      if (!args) {
        if (!projects.length) return '还没有可用的工作区会话。';
        return ['工作区列表（/项目 <名称> 切换）：', ...projects.map((p, i) => `${i + 1}. ${baseName(p)}`)].join('\n');
      }
      const chosen = pick(projects, args);
      if (!chosen) return `没有匹配「${args}」的工作区。`;
      bindings[chatId] = { cwd: chosen };
      return `已切换工作区：${baseName(chosen)}`;
    }
    case '状态':
    case 'status':
      return actions.status(binding.cwd);
    case '模型':
    case 'model': {
      const models = await actions.listModels(binding.cwd);
      if (!args) {
        if (!models.length) return '当前工作区没有活跃会话，无法列出模型。先 /新建 或在桌面端打开会话。';
        return ['可用模型（/模型 <序号> 切换）：', ...models.map((m, i) => `${i + 1}. ${m}`)].join('\n');
      }
      const index = Number(args) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= models.length) return `序号无效，范围 1-${models.length}。`;
      return actions.switchModel(index, binding.cwd);
    }
    case '新建':
    case 'clear':
    case 'new': {
      if (!binding.cwd) {
        const projects = await actions.listProjects();
        if (!projects.length) return '还没有可用的工作区会话。先在桌面端新建一个。';
        bindings[chatId] = { cwd: projects[0] };
      }
      return actions.newTask(bindings[chatId].cwd);
    }
    case '思考':
    case 'thinking': {
      const levels = actions.thinkingLevels();
      if (!args) return `当前可选思考级别：${levels.join(' / ')}。发送 /思考 <级别> 设置。`;
      if (!levels.includes(args)) return `无效级别「${args}」。可选：${levels.join(' / ')}`;
      return actions.setThinking(args);
    }
    case '模式':
    case 'mode': {
      const modes = actions.modes();
      const current = bindings[chatId] ?? (bindings[chatId] = {});
      if (!args) {
        const at = modes.indexOf(current.mode ?? '');
        const next = at < 0 ? modes[0] : modes[(at + 1) % modes.length];
        current.mode = next;
        return actions.setMode(next);
      }
      if (!modes.includes(args)) return `无效模式「${args}」。可选：${modes.join(' / ')}`;
      current.mode = args;
      return actions.setMode(args);
    }
    case '回复':
      return '回复详细程度暂不支持。';
    default:
      return `未知命令 /${cmd}。发送 /帮助 查看可用命令。`;
  }
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

function pick(list: string[], args: string): string | undefined {
  const byIndex = Number(args) - 1;
  if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < list.length) return list[byIndex];
  const lower = args.toLowerCase();
  return list.find((p) => p.toLowerCase().includes(lower) || baseName(p).toLowerCase() === lower);
}
