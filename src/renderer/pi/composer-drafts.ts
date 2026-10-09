// Composer drafts kept per conversation while the user switches between
// sessions. Memory-only: drafts survive in-app switches (sidebar, nav
// back/forward, new-session hop) but not an app restart.

import type { ContextItem } from '../../shared/composer';

export interface ComposerDraft { text: string; items: ContextItem[] }

const EMPTY: ComposerDraft = { text: '', items: [] };
const MAX_DRAFTS = 200;

export function emptyDraft(): ComposerDraft {
  return { text: '', items: [] };
}

export function isMeaningfulDraft(draft: ComposerDraft | undefined): boolean {
  return Boolean(draft && (draft.text.length > 0 || draft.items.length > 0));
}

export function readComposerDraft(drafts: Map<string, ComposerDraft>, ownerKey: string): ComposerDraft {
  const draft = drafts.get(ownerKey);
  return draft ? { text: draft.text, items: [...draft.items] } : emptyDraft();
}

/** Returns a new Map with the draft stored; evicts the oldest entries beyond MAX_DRAFTS. */
export function storeComposerDraft(
  drafts: Map<string, ComposerDraft>,
  ownerKey: string,
  draft: ComposerDraft,
): Map<string, ComposerDraft> {
  const next = new Map(drafts);
  next.delete(ownerKey);
  next.set(ownerKey, { text: draft.text, items: [...draft.items] });
  while (next.size > MAX_DRAFTS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}
