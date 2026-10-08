/** Only aggregate metadata crosses from the runtime to the renderer. */
export const CONTEXT_CATEGORIES = ['messages', 'systemTools', 'mcpTools', 'skills', 'systemPrompt', 'other'] as const;
export type ContextCategory = typeof CONTEXT_CATEGORIES[number];
export interface ContextDetails {
  breakdown: Array<{ category: ContextCategory; chars: number }>;
  /** Character-based estimate over the active RPC transcript, not provider-exact tokens.
   *  'skipped-large-session'：大会话跳过全量历史拉取，breakdown 恒为空（不伪造占比）。 */
  method: 'active-transcript-chars' | 'skipped-large-session';
  cacheHitRate: number | null;
  fetchedAt: number;
}
/** Cache-hit rate from get_session_stats token distribution alone — 不依赖全量历史消息，
 *  大会话跳过明细拉取时仍可如实计算。 */
export function cacheHitRateFromTotals(totals: unknown): number | null {
  const t = totals as Record<string, unknown> | undefined;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const denominator = valid(t?.input) && valid(t?.cacheRead) && valid(t?.cacheWrite) ? t.input + t.cacheRead + t.cacheWrite : 0;
  return denominator > 0 ? (t!.cacheRead as number) / denominator * 100 : null;
}
export interface PlanQuota {
  status: 'ready' | 'unsupported' | 'unauthenticated' | 'unavailable';
  provider: string;
  fetchedAt: number;
  limits: Array<{ label: string; remainingPercent: number; resetsAt?: number }>;
}
