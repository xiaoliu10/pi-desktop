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
