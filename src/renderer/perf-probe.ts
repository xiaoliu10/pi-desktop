/**
 * 输入延迟 / 长任务埋点（诊断用，默认开启，可一键关闭）。
 *
 * 背景（docs/design/input-lag.md）：用户反馈大会话「打字卡」。Composer 已本地优先
 * （键入只碰 local state，200ms 防抖才写 store），所以按键本身不触发重渲染——卡是
 * 按键撞上同帧正在进行的别人家长帧。要定位必须度量：
 *
 *  1. Event Timing（`first-input`/`event` 条目）：`processingStart - startTime` =
 *     从用户按键到浏览器开始处理的延迟。这是「打字卡」的直接度量，阈值 16ms。
 *     含 inputDelay（排队等主线程）+ processingTime。
 *  2. longtask：>50ms 的任务会阻塞输入。记录次数/总时长/最长任务，并按归属分组
 *     （React commit / history IPC / 解析 等由调用方显式标注 currentPhase）。
 *  3. 帧率采样：requestAnimationFrame 间隔，卡顿期掉帧可见。
 *
 * 用法：
 *  - 打开 app 后按 ⌘⇧P 面板里的「导出输入延迟报告」，或控制台 `__piPerf.report()`
 *  - `__piPerf.start('history-ipc')` / `__piPerf.end('history-ipc')` 由调用方标注阶段，
 *    长任务若落在某阶段内，会归因到该阶段（未命中归 'other'）
 *  - 关闭：设置里搜索「输入延迟埋点」或 `__piPerf.disable()`
 */

type Phase = string;

interface InputSample { at: number; delay: number; duration: number; target: string }
interface LongTaskSample { at: number; duration: number; phase: Phase }
interface FrameSample { at: number; delta: number }

const inputSamples: InputSample[] = [];
const longTasks: LongTaskSample[] = [];
const frameDrops: FrameSample[] = [];
/** 已结束的阶段区间：PerformanceObserver 回调是异步批量的，晚于 end() 到达，
 *  所以不能只看「当前在哪个 phase」，要按时间区间匹配（startedAt..endedAt）。 */
const phaseWindows: { phase: Phase; startedAt: number; endedAt: number }[] = [];
/** 每类事件的最近 N 条明细（报告里给出 top 样本，便于判断是「打字时」还是「聚焦时」） */
const MAX_SAMPLES = 500;
let enabled = true;
let startedAt = Date.now();
let rafId = 0;
let lastFrameAt = 0;

function targetOf(entry: any): string {
  const t = entry?.target;
  if (!t) return 'unknown';
  // 输入框打字 / 点击 / 滚动 分类：报告要能一眼看出「慢的是不是打字」。
  // 用特性检测而非 instanceof（node 测试环境无 HTMLTextAreaElement 全局）。
  const tag = String(t.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || (tag === 'input' && !/button|checkbox|radio|range|color/i.test(String(t.type ?? '')))) return 'text-input';
  return tag || 'unknown';
}

export function installPerfProbe(): void {
  if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return;

  // 1) 输入延迟：Event Timing（Chrome 96+）。注意 threshold 16ms 以下的输入会被丢弃，
  //    默认 104ms——必须显式调低才能抓到 16-100ms 的「轻微卡」。
  try {
    const io = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as any[]) {
        if (!enabled) continue;
        const delay = entry.processingStart - entry.startTime;
        const duration = entry.processingEnd ? entry.processingEnd - entry.startTime : (entry.duration ?? 0);
        if (delay < 8) continue; // 人类感知不到的忽略，报告只留可疑样本
        inputSamples.push({ at: entry.startTime, delay, duration, target: targetOf(entry) });
        if (inputSamples.length > MAX_SAMPLES) inputSamples.shift();
      }
    });
    io.observe({ type: 'event', buffered: true, durationThreshold: 16 } as any);
  } catch { /* 老内核不支持 Event Timing：只留 longtask 埋点 */ }

  // 2) 长任务：>50ms 即阻塞输入。归因到最近开始的 phase。
  try {
    const lo = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as any[]) {
        if (!enabled) continue;
        longTasks.push({ at: entry.startTime, duration: entry.duration, phase: phaseOf(entry.startTime) });
        if (longTasks.length > MAX_SAMPLES) longTasks.shift();
      }
    });
    lo.observe({ type: 'longtask', buffered: true } as any);
  } catch { /* 不支持 */ }

  // 3) 帧采样：掉帧（>32ms/帧）说明主线程被占，与输入延迟互证。
  const tick = (now: number) => {
    if (enabled && lastFrameAt) {
      const delta = now - lastFrameAt;
      if (delta > 32) { frameDrops.push({ at: now, delta }); if (frameDrops.length > MAX_SAMPLES) frameDrops.shift(); }
    }
    lastFrameAt = now;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function startPhase(phase: Phase): void {
  phaseWindows.push({ phase, startedAt: performance.now(), endedAt: Number.POSITIVE_INFINITY });
}

export function endPhase(phase: Phase): void {
  // 关掉最近一个未闭合的同名 phase（乱序/嵌套 end 不炸）
  const now = performance.now();
  for (let i = phaseWindows.length - 1; i >= 0; i -= 1) {
    const w = phaseWindows[i]!;
    if (w.phase === phase && !Number.isFinite(w.endedAt)) { w.endedAt = now; return; }
  }
}

/** 长任务归属：按开始时间落在哪个 phase 区间内判（未命中归 other）。
 *  ±SLACK_MS 容差：PerformanceObserver 的上报时刻与 startPhase() 的记录时刻有毫秒级错位
 *  （phase 在 await 之前开始，长任务在 await 内部产生，startTime 可能略小于 startedAt）。 */
const SLACK_MS = 5;
function phaseOf(at: number): Phase {
  for (const w of phaseWindows) {
    const end = Number.isFinite(w.endedAt) ? w.endedAt : Number.POSITIVE_INFINITY;
    if (at >= w.startedAt - SLACK_MS && at <= end + SLACK_MS) return w.phase;
  }
  return 'other';
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return Math.round(sorted[idx]!);
}

function summarize(values: number[]): { n: number; p50: number; p90: number; max: number; total: number } {
  const total = Math.round(values.reduce((s, v) => s + v, 0));
  return { n: values.length, p50: pct(values, 50), p90: pct(values, 90), max: values.length ? Math.round(Math.max(...values)) : 0, total };
}

/** 报告：控制台 `__piPerf.report()` 或设置页「导出」按钮。 */
export function perfReport(): string {
  const now = Date.now();
  const minutes = Math.max(1, Math.round((now - startedAt) / 60000));
  const byTarget = new Map<string, number[]>();
  for (const s of inputSamples) {
    if (!byTarget.has(s.target)) byTarget.set(s.target, []);
    byTarget.get(s.target)!.push(s.delay);
  }
  const byPhase = new Map<Phase, number[]>();
  for (const t of longTasks) {
    if (!byPhase.has(t.phase)) byPhase.set(t.phase, []);
    byPhase.get(t.phase)!.push(t.duration);
  }
  const lines: string[] = [];
  lines.push(`═══ 输入延迟报告（${minutes} 分钟窗口）════`);
  lines.push(`输入延迟（processingStart-startTime，>8ms 采样）:`);
  for (const [target, delays] of byTarget) {
    const s = summarize(delays);
    lines.push(`  ${target.padEnd(12)} n=${s.n} p50=${s.p50}ms p90=${s.p90}ms max=${s.max}ms 总阻塞=${s.total}ms`);
  }
  lines.push(`长任务（>50ms，按阶段归因）:`);
  if (!longTasks.length) lines.push('  无');
  for (const [phase, durations] of [...byPhase.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const s = summarize(durations);
    lines.push(`  ${phase.padEnd(20)} n=${s.n} p50=${s.p50}ms max=${s.max}ms 总阻塞=${s.total}ms`);
  }
  const frames = summarize(frameDrops.map(f => f.delta));
  lines.push(`掉帧（>32ms）: n=${frames.n} p50=${frames.p50}ms max=${frames.max}ms`);
  lines.push(`未归因长任务: ${longTasks.filter(t => t.phase === 'other').length} / ${longTasks.length}`);
  if (inputSamples.length) {
    const worst = [...inputSamples].sort((a, b) => b.delay - a.delay).slice(0, 5);
    lines.push('最慢的 5 次输入:');
    for (const w of worst) lines.push(`  ${w.target} delay=${Math.round(w.delay)}ms duration=${Math.round(w.duration)}ms`);
  }
  const text = lines.join('\n');
  console.log(text);
  return text;
}

export function resetPerfProbe(): void {
  inputSamples.length = 0;
  longTasks.length = 0;
  phaseWindows.length = 0;
  frameDrops.length = 0;
  startedAt = Date.now();
}

/** 调试钩子：控制台 `__piPerf.report()/reset()/disable()`。 */
export function installPerfGlobals(): void {
  if (typeof window === 'undefined') return;
  (window as any).__piPerf = {
    report: perfReport,
    reset: resetPerfProbe,
    disable: () => { enabled = false; },
    enable: () => { enabled = true; },
    start: startPhase,
    end: endPhase,
  };
}
