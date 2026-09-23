/** Only aggregate metadata crosses from the runtime to the renderer. */
export const CONTEXT_CATEGORIES = ['messages', 'systemTools', 'mcpTools', 'skills', 'systemPrompt', 'other'] as const;
export type ContextCategory = typeof CONTEXT_CATEGORIES[number];
export interface ContextDetails {
  breakdown: Array<{ category: ContextCategory; chars: number }>;
  /** Character-based estimate over the active RPC transcript, not provider-exact tokens. */
  method: 'active-transcript-chars';
  cacheHitRate: number | null;
  fetchedAt: number;
}
export interface PlanQuota {
  status: 'ready' | 'unsupported' | 'unauthenticated' | 'unavailable';
  provider: string;
  fetchedAt: number;
  limits: Array<{ label: string; remainingPercent: number; resetsAt?: number }>;
}
