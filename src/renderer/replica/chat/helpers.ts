/**
 * Pure helpers for the chat replica (U03): menu input parsing, message nav
 * points and markdown sanity. Framework-free for preview tests.
 */

import type { ChatMessage, SlashCommand } from '../contracts';

export interface MenuState {
  /** Active popup: slash commands, file mentions, or none. */
  kind: 'slash' | 'file' | null;
  query: string;
}

/**
 * Parse the composer text (caret at end) into a popup state.
 * A `/` at position 0 (or after whitespace) opens commands; an `@` opens
 * file mentions. Any whitespace after the trigger closes it.
 */
export function parseMenuState(text: string): MenuState {
  const m = /(^|\s)([/@])(\S*)$/.exec(text);
  if (!m) return { kind: null, query: '' };
  return { kind: m[2] === '/' ? 'slash' : 'file', query: m[3].toLowerCase() };
}

export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.replace(/^\//, '').toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
  );
}

export function filterFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return files;
  return files.filter((f) => f.toLowerCase().includes(q));
}

/** Replaces the trailing trigger token with the chosen value + space. */
export function applyMenuSelection(text: string, choice: string): string {
  return text.replace(/(^|\s)([/@])\S*$/, (_all, pre: string) => `${pre}${choice} `);
}

export interface NavPoint {
  messageId: string;
  /** 0..1 relative offset used to place the rail marker. */
  ratio: number;
  role: 'user' | 'assistant';
}

/**
 * Rail markers: one per message, positioned by index (not pixel height) so
 * tests are deterministic; the view maps index → scroll offset on click.
 */
export function buildNavPoints(messages: ChatMessage[]): NavPoint[] {
  if (messages.length === 0) return [];
  return messages.map((m, i) => ({
    messageId: m.id,
    ratio: messages.length === 1 ? 0 : i / (messages.length - 1),
    role: m.role,
  }));
}

/** Flat text of a message's text parts — used for search indexing. */
export function messageText(message: ChatMessage): string {
  return message.parts
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'notice' ? p.text : p.kind === 'error' ? p.message : ''))
    .join(' ');
}

export function countDots(diff: { lines: Array<{ type: string }> }): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of diff.lines) {
    if (l.type === '+') additions++;
    else if (l.type === '-') deletions++;
  }
  return { additions, deletions };
}

/** 每组默认展示的模型数（openrouter 这类上百个模型的供应商全量铺开没法找）。 */
export const MODEL_MENU_LIMIT = 10;

export interface MenuModelGroup {
  provider: string;
  /** 实际展示的模型。 */
  models: Array<{ id: string; name: string; detail?: string }>;
  /** 未展示的数量（>0 时 UI 提示「还有 N 个，输入名称筛选」）。 */
  truncated: number;
  /** 该组模型总数。 */
  total: number;
}

/** 模型菜单的展示规约：无筛选=每组只展示前 MODEL_MENU_LIMIT 个；有筛选=按名称/ID/供应商
 *  名跨组匹配且不截断（筛选就是精确找模型的路径），空组与空供应商剔除。 */
export function filterModelGroups(groups: Array<{ provider: string; models: Array<{ id: string; name: string; detail?: string }> }>, query: string): MenuModelGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return groups
      .filter(g => g.models.length > 0)
      .map(g => ({ provider: g.provider, models: g.models.slice(0, MODEL_MENU_LIMIT), truncated: Math.max(0, g.models.length - MODEL_MENU_LIMIT), total: g.models.length }));
  }
  return groups
    .map(g => {
      const providerHit = g.provider.toLowerCase().includes(q);
      const models = providerHit ? g.models : g.models.filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
      return { provider: g.provider, models, truncated: 0, total: g.models.length };
    })
    .filter(g => g.models.length > 0);
}

/** 图像模型按供应商分组（组内按目录顺序），供模型菜单的「图像生成」区块复用
 *  filterModelGroups 的截断/筛选规约。key = provider/model 是生图目标的唯一标识。 */
export function groupImageModels(models: Array<{ key: string; provider: string; providerName: string; name: string }>): Array<{ provider: string; models: Array<{ id: string; name: string }> }> {
  const groups = new Map<string, { provider: string; models: Array<{ id: string; name: string }> }>();
  for (const m of models) {
    let g = groups.get(m.provider);
    if (!g) { g = { provider: m.providerName || m.provider, models: [] }; groups.set(m.provider, g); }
    g.models.push({ id: m.key, name: m.name });
  }
  return [...groups.values()];
}
