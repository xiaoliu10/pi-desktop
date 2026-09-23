import fs from 'node:fs';
import path from 'node:path';
import type { PiSession } from '../../shared/pi';

/**
 * Aggregated usage statistics over the local pi session files. Every
 * assistant message carries usage (tokens + cost) plus model/provider and a
 * timestamp, so the totals are computed from the same source of truth the
 * pi CLI writes — nothing is tracked separately on the desktop side.
 */

export interface UsageBucket {
  model: string;
  provider: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface UsageStats {
  sessions: number;
  userMessages: number;
  assistantMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  byModel: UsageBucket[];
  byDay: Array<{ day: string; tokens: number; cost: number; messages: number }>;
  byProject: Array<{ cwd: string; sessions: number; tokens: number; cost: number }>;
}

interface Acc {
  sessions: number;
  userMessages: number;
  assistantMessages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  models: Map<string, UsageBucket>;
  days: Map<string, { day: string; tokens: number; cost: number; messages: number }>;
  projects: Map<string, { cwd: string; sessions: number; tokens: number; cost: number }>;
}

function addUsage(acc: Acc, u: Record<string, unknown>, cost: number): void {
  acc.input += Number(u.input) || 0;
  acc.output += Number(u.output) || 0;
  acc.cacheRead += Number(u.cacheRead) || 0;
  acc.cacheWrite += Number(u.cacheWrite) || 0;
  acc.total += Number(u.totalTokens) || 0;
  acc.cost += cost;
}

export function computeUsageStats(sessions: PiSession[], now = new Date()): UsageStats {
  const acc: Acc = {
    sessions: 0, userMessages: 0, assistantMessages: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
    models: new Map(), days: new Map(), projects: new Map(),
  };
  for (const session of sessions) {
    let sessionTokens = 0, sessionCost = 0, touched = false;
    try {
      const raw = fs.readFileSync(session.path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.includes('"usage"')) continue;
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const message = entry.message as Record<string, unknown> | undefined;
        if (!message || message.role !== 'assistant') continue;
        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        touched = true;
        acc.assistantMessages += 1;
        const cost = Number((usage.cost as Record<string, unknown> | undefined)?.total) || 0;
        addUsage(acc, usage, cost);
        sessionTokens += Number(usage.totalTokens) || 0;
        sessionCost += cost;
        const model = String(message.model ?? 'unknown');
        const provider = String(message.provider ?? 'unknown');
        const key = `${provider}/${model}`;
        const bucket = acc.models.get(key) ?? { model, provider, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
        bucket.calls += 1;
        bucket.input += Number(usage.input) || 0;
        bucket.output += Number(usage.output) || 0;
        bucket.cacheRead += Number(usage.cacheRead) || 0;
        bucket.cacheWrite += Number(usage.cacheWrite) || 0;
        bucket.total += Number(usage.totalTokens) || 0;
        bucket.cost += cost;
        acc.models.set(key, bucket);
        const ts = typeof message.timestamp === 'string' ? message.timestamp : typeof entry.timestamp === 'string' ? entry.timestamp : '';
        const day = ts.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          const dayBucket = acc.days.get(day) ?? { day, tokens: 0, cost: 0, messages: 0 };
          dayBucket.tokens += Number(usage.totalTokens) || 0;
          dayBucket.cost += cost;
          dayBucket.messages += 1;
          acc.days.set(day, dayBucket);
        }
      }
      if (touched || fs.existsSync(session.path)) {
        acc.sessions += 1;
        const proj = acc.projects.get(session.cwd) ?? { cwd: session.cwd, sessions: 0, tokens: 0, cost: 0 };
        proj.sessions += 1;
        proj.tokens += sessionTokens;
        proj.cost += sessionCost;
        acc.projects.set(session.cwd, proj);
      }
      // user messages: cheap second pass signal
      acc.userMessages += (raw.match(/"role":"user"/g) ?? []).length;
    } catch {
      continue; // unreadable session files are skipped, not fatal
    }
  }
  const cutoff = new Date(now.getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
  const byDay = [...acc.days.values()].filter((d) => d.day >= cutoff).sort((a, b) => a.day.localeCompare(b.day));
  return {
    sessions: acc.sessions,
    userMessages: acc.userMessages,
    assistantMessages: acc.assistantMessages,
    tokens: { input: acc.input, output: acc.output, cacheRead: acc.cacheRead, cacheWrite: acc.cacheWrite, total: acc.total },
    cost: acc.cost,
    byModel: [...acc.models.values()].sort((a, b) => b.total - a.total),
    byDay,
    byProject: [...acc.projects.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
  };
}

/** Cached snapshot: rescans at most once per minute. */
export class UsageStatsService {
  private cache: { at: number; stats: UsageStats } | null = null;
  constructor(private readonly sessions: () => PiSession[]) {}

  get(): UsageStats {
    if (!this.cache || Date.now() - this.cache.at > 60_000) {
      this.cache = { at: Date.now(), stats: computeUsageStats(this.sessions()) };
    }
    return this.cache.stats;
  }
}
