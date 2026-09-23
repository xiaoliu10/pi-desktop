/**
 * BotActions implementation: adapts the pi host + desktop settings into the
 * channel-agnostic command engine. All actions act on the SAME sessions the
 * desktop UI drives — the bot is another client of one workspace, not a
 * separate agent. Remote-created sessions default to permission 'ask', so
 * tool confirmations surface on the desktop (and as IM notices).
 */

import path from 'node:path';
import type { PiHost } from '../host';
import type { SettingsService } from '../settings-service';
import type { PiRun } from '../../../shared/pi';
import type { BotActions } from './engine';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODE_LABELS: Record<string, string> = { followUp: '排队追问', steer: '调整当前任务' };

const norm = (p: string) => path.resolve(p);
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

export function createBotActions(host: PiHost, settings: SettingsService): BotActions {
  const runsFor = (cwd?: string): PiRun[] => {
    const runs = host.backend.runs();
    if (!cwd) return runs;
    const target = norm(cwd);
    return runs.filter((r) => norm(r.cwd) === target);
  };
  const latestRun = (cwd?: string): PiRun | undefined =>
    runsFor(cwd).slice().sort((a, b) => (b.timing?.startedAt ?? 0) - (a.timing?.startedAt ?? 0))[0];

  const projects = (): string[] => {
    const sessions = host.index.scan();
    const byCwd = new Map<string, number>();
    for (const s of sessions) byCwd.set(s.cwd, Math.max(byCwd.get(s.cwd) ?? 0, s.updatedAt));
    for (const r of host.backend.runs()) if (!byCwd.has(r.cwd)) byCwd.set(r.cwd, r.timing?.startedAt ?? 0);
    return [...byCwd.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
  };

  return {
    async status(cwd) {
      const run = latestRun(cwd);
      const lines: string[] = [];
      lines.push(`pi ${host.environment.version ?? '未发现'} · 会话 ${host.index.scan().length} 个 · 工作区 ${projects().length} 个`);
      if (run) {
        lines.push(`当前任务：${baseName(run.cwd)} · ${run.status}`);
        if (run.model) lines.push(`模型：${run.model.provider}/${run.model.name}`);
        if (run.pending) lines.push(`排队输入：${run.pending} 条`);
        if (run.error) lines.push(`错误：${run.error}`);
      } else {
        lines.push(cwd ? `${baseName(cwd)} 没有活跃会话，发送 /新建 开始。` : '没有活跃会话。');
      }
      return lines.join('\n');
    },
    async listProjects() {
      return projects();
    },
    async listModels(cwd) {
      const run = latestRun(cwd);
      if (!run) return [];
      return run.models.map((m) => `${m.provider}/${m.name}`);
    },
    async switchModel(index, cwd) {
      const run = latestRun(cwd);
      if (!run) throw new Error('没有活跃会话，先 /新建。');
      const model = run.models[index];
      if (!model) throw new Error('模型序号无效。');
      await host.backend.model(run.key, model.provider, model.id);
      return `已切换模型：${model.provider}/${model.name}`;
    },
    async newTask(cwd) {
      if (!cwd) throw new Error('未绑定工作区，先发送 /项目 列表并切换。');
      const run = await host.backend.connect({ cwd, trustProject: true, permission: 'ask' });
      return `已创建新任务：${baseName(run.cwd)}（权限：变更前确认，工具确认在桌面端弹出）。直接发文字即可下达指令。`;
    },
    async setThinking(level) {
      const snap = settings.snapshot();
      await Promise.resolve(settings.saveAi({ ...snap.ai, defaultThinkingLevel: level }));
      return `思考级别已设为 ${level}，新建或重载会话后生效。`;
    },
    async prompt(text, cwd) {
      let run = latestRun(cwd);
      if (!run) {
        if (!cwd) throw new Error('未绑定工作区，先发送 /bind。');
        run = await host.backend.connect({ cwd, trustProject: true, permission: 'ask' });
      }
      const behavior = settings.preferences().behavior;
      await host.backend.prompt(run.key, text, behavior);
      return `已发送到 ${baseName(run.cwd)}（${behavior === 'steer' ? '调整当前任务' : '排队追问'}）。`;
    },
    modes() {
      return Object.keys(MODE_LABELS);
    },
    async setMode(mode) {
      settings.savePreferences({ behavior: mode === 'steer' ? 'steer' : 'followUp' });
      return `输入策略已切换：${MODE_LABELS[mode] ?? mode}（全局默认）。`;
    },
    thinkingLevels() {
      return THINKING_LEVELS;
    },
    promptAllowed() {
      return true; // tool execution is still gated by the session's own access mode
    },
  };
}
