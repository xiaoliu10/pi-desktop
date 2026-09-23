/**
 * Pure helpers for the plugins replica (U04): tab filtering, search, status
 * grouping, marketplace tag filtering. Framework-free for preview tests.
 */

import type { MarketplaceCardData, PluginRowData, PluginStatus } from '../contracts';

export const STATUS_ORDER: PluginStatus[] = ['attention', 'updatable', 'active', 'off'];

export function filterInstalled(rows: PluginRowData[], query: string): PluginRowData[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (p) => p.name.toLowerCase().includes(q) || p.packageId.toLowerCase().includes(q),
  );
}

export function groupByStatus(rows: PluginRowData[]): Array<{ status: PluginStatus; items: PluginRowData[] }> {
  return STATUS_ORDER.map((status) => ({ status, items: rows.filter((r) => r.status === status) })).filter(
    (g) => g.items.length > 0,
  );
}

export function filterMarketplace(cards: MarketplaceCardData[], query: string, tag: string): MarketplaceCardData[] {
  const q = query.trim().toLowerCase();
  return cards.filter((c) => {
    if (tag !== 'all' && !c.tags.includes(tag)) return false;
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.publisher.toLowerCase().includes(q);
  });
}

export function uniqueTags(cards: MarketplaceCardData[]): string[] {
  const set = new Set<string>();
  for (const c of cards) for (const t of c.tags) set.add(t);
  return [...set].sort();
}
