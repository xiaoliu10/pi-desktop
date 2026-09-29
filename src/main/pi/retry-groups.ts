import type { PiRetryGroup } from '../../shared/pi';

/** Desktop budget; deliberately independent of settings.retry / CLI attempt counts. */
export const RETRY_GROUP_DELAYS_MS = [10, 20, 40, 80, 160, 300, 600, 900, 1200].map(s => s * 1000);
export const MAX_RETRY_GROUPS = 10;

/** Fail closed: exhaustion can also follow a permanent error or an explicit abort. */
export function isTransientUpstreamError(error: unknown): boolean {
  if (typeof error !== 'string' || !error.trim()) return false;
  if (/cancel|abort|\b(?:400|401|403|404|422)\b|unauthori[sz]ed|forbidden|invalid.?api.?key|insufficient.?quota|billing|context.{0,20}(?:length|window|overflow)|prompt.{0,12}too long/i.test(error)) return false;
  return /\b(?:408|429|500|502|503|504|529)\b|overload|rate.?limit|too many requests|resource.?exhausted|temporar(?:y|ily)|service unavailable|internal server error|fetch failed|connection error|connection (?:reset|closed|refused)|socket hang up|network|timed? ?out|timeout|terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_/i.test(error);
}

/** One instance per live writer generation. No persistence/replay across process reconnects. */
export class RetryGroups {
  state?: PiRetryGroup;
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private active = false;
  private exhausted = false;
  private maxAttempts = 0;
  private lastOutcome?: string;

  constructor(private changed: (state: PiRetryGroup | undefined) => void,
    private resume: () => Promise<void>) {}

  get tracking() { return this.active; }
  get needsSettlement() { return this.active && this.exhausted && !this.waiting; }
  get holding() { return this.active && (this.exhausted || (this.state?.group ?? 1) > 1); }
  get waiting() { return this.state?.phase === 'waiting'; }
  get recovering() { return this.active && (this.state?.group ?? 1) > 1; }
  private publish(patch: Partial<PiRetryGroup>) {
    this.state = { ...this.state!, ...patch };
    this.changed(this.state);
  }
  begin() {
    this.clear();
    this.active = true;
    this.lastOutcome = undefined;
    this.state = { group: 1, maxGroups: MAX_RETRY_GROUPS, phase: 'running' };
    this.changed(this.state);
  }
  private clear() {
    ++this.epoch;
    clearTimeout(this.timer); this.timer = undefined;
    this.active = false; this.exhausted = false; this.maxAttempts = 0;
  }
  cancel() {
    this.clear();
    if (this.state) this.publish({ phase: 'cancelled', nextRetryAt: undefined, delayMs: undefined });
  }
  dispose() { this.clear(); }
  fail(error: unknown) {
    this.clear();
    if (this.state) this.publish({ phase: 'failed', error: String(error instanceof Error ? error.message : error), nextRetryAt: undefined, delayMs: undefined });
  }
  /** Returns true only when the CLI settlement is intermediate for Desktop. */
  event(event: Record<string, any>): boolean {
    if (!this.active) return false;
    // A real user message after a terminal answer is a new independently queued
    // task. agent_start alone also fires for internal retries and must not reset.
    // Steering after toolUse/error remains part of the unfinished task.
    if (event.type === 'message_start' && event.message?.role === 'user'
      && ['stop', 'length'].includes(this.lastOutcome ?? '')) this.begin();
    if (event.type === 'agent_start') {
      // Natural CLI/extension continuations supersede an obsolete exhaustion signal.
      this.exhausted = false;
      if (this.waiting) { clearTimeout(this.timer); this.timer = undefined; ++this.epoch; }
      this.publish({ phase: 'running', nextRetryAt: undefined, delayMs: undefined });
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') this.lastOutcome = event.message.stopReason;
    if (event.type === 'auto_retry_start') {
      this.maxAttempts = Number.isInteger(event.maxAttempts) && event.maxAttempts > 0 ? event.maxAttempts : 0;
    }
    if (event.type === 'auto_retry_end') {
      // A successful internal retry (possibly toolUse or even aborted in older CLI)
      // is not a settled task and must NEVER replenish the Desktop budget.
      this.exhausted = event.success === false && this.maxAttempts > 0
        && event.attempt >= this.maxAttempts && this.lastOutcome === 'error'
        && isTransientUpstreamError(event.finalError);
      this.maxAttempts = 0;
    }
    if (event.type !== 'agent_settled') return false;
    if (this.waiting) return true; // Duplicate notification must not allocate another timer/group.
    if (this.exhausted && this.state!.group < MAX_RETRY_GROUPS) {
      const epoch = this.epoch;
      const delayMs = RETRY_GROUP_DELAYS_MS[this.state!.group - 1];
      this.publish({ phase: 'waiting', delayMs, nextRetryAt: Date.now() + delayMs });
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.active || this.epoch !== epoch) return;
        this.exhausted = false;
        this.publish({ group: this.state!.group + 1, phase: 'running', delayMs: undefined, nextRetryAt: undefined });
        // A timeout/rejection is ambiguous: never retry this dispatch or replay a prompt.
        void this.resume().catch(error => {
          if (!this.active || this.epoch !== epoch) return;
          this.fail(error);
        });
      }, delayMs);
      this.timer.unref?.();
      return true;
    }
    const phase = this.lastOutcome === 'aborted' ? 'cancelled'
      : this.exhausted ? 'exhausted'
      : ['stop', 'length', 'toolUse'].includes(this.lastOutcome ?? '') ? 'completed' : 'failed';
    this.clear();
    this.publish({ phase, delayMs: undefined, nextRetryAt: undefined });
    return false;
  }
}
