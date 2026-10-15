import type { ChatMessage } from '../replica/contracts';
import type { PlanItem } from '../../shared/conversation-status';

/**
 * 计划查看器的数据源（复刻 ZCode planToolCall.ts 的职责）。
 *
 * ZCode 的计划来自 ExitPlanMode 工具调用的 markdown；pi Desktop 的计划模式没有这个
 * 工具，计划文档就是计划模式下助手最后一条带正文的文本消息 —— 与后端置 planReady
 * 用的是同一个信号（backend.ts message_end 判定）。任务清单（desktop_update_plan）
 * 由 conversation-plan.ts 单独解析，查看器里作为进度附页展示。
 */

export interface PlanDocument {
  title: string;
  markdown: string;
}

const MARKDOWN_H1 = /^[^\S\r\n]{0,3}#(?!#)\s+(.+?)\s*#*\s*$/m;
const MARKDOWN_LEADING_DECORATION = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/;

/** 计划标题取首个 H1，否则取首个非空文本行；超长截断。 */
export function planDocumentTitle(markdown: string, fallback = '计划'): string {
  const h1 = MARKDOWN_H1.exec(markdown)?.[1]?.trim();
  const raw = (
    h1 ??
    markdown
      .split(/\r?\n/u)
      .map((line) => line.replace(MARKDOWN_LEADING_DECORATION, '').trim())
      .find(Boolean) ??
    ''
  ).trim();
  if (!raw) return fallback;
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

/** 由快照 markdown 还原文档（会话切走 / 执行模式 / 重启后的兜底展示）。 */
export function planFromMarkdown(markdown: string, fallback = '计划'): PlanDocument {
  return { title: planDocumentTitle(markdown, fallback), markdown };
}

/** 未走计划模式的会话：把任务清单合成为一份可审阅的计划文档（md 表格，
 *  像预约页 / md 文档一样整页展示状态+计划项），替代「暂无计划文档」的空态。
 *  只使用清单自身数据（step+status），不虚构任何明细。 */
export function planDocumentFromChecklist(checklist: PlanItem[], lang: 'zh' | 'en' = 'zh'): PlanDocument | null {
  if (!checklist.length) return null;
  const zh = lang === 'zh';
  const done = checklist.filter((item) => item.status === 'completed').length;
  const statusCell: Record<PlanItem['status'], string> = {
    completed: zh ? '✅ 已完成' : '✅ completed',
    in_progress: zh ? '🔄 进行中' : '🔄 in progress',
    pending: zh ? '⬜ 待处理' : '⬜ pending',
  };
  const cell = (step: string) => step.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const title = zh ? '任务计划' : 'Task plan';
  const markdown = [
    `# ${title}`,
    '',
    zh ? `进度：${done}/${checklist.length} 已完成` : `Progress: ${done}/${checklist.length} completed`,
    '',
    zh ? '| 状态 | 计划项 |' : '| Status | Plan item |',
    '| --- | --- |',
    ...checklist.map((item) => `| ${statusCell[item.status]} | ${cell(item.step)} |`),
  ].join('\n');
  return { title, markdown };
}

function assistantText(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('\n\n')
    .trim();
}

/**
 * 实时计划文档 = 最后一条含正文的助手消息（向前回溯，跳过纯工具调用消息）。
 * 只应在 accessMode==='plan' 时取实时值；执行模式继续沿用旧值会拿执行叙述
 * 覆盖计划，调用方须改用快照。
 */
export function planDocument(messages: ChatMessage[]): PlanDocument | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const markdown = assistantText(message);
    if (!markdown) continue;
    return planFromMarkdown(markdown);
  }
  return null;
}
