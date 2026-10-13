/**
 * 手机端（LAN 远程控制）的会话可见性口径 —— 与桌面侧栏保持一致：
 * 已归档会话、已移除/隐藏项目、subagent 内部会话（parentSession）与
 * 副驾会话（sidecarOf）一律不可见。
 *
 * 关键口径：
 * - 「已移除项目」比对用 session-index.canonical 归一化两侧路径：偏好里存的
 *   canonical 路径与会话头/run 里的 cwd 可能隔着符号链接别名（用户从别名目录
 *   启动 pi），不归一化就等于「删了还能刷出来」。
 * - /api/state、/api/history 是低频路径，每次强制现算（偏好是动态的）；
 *   SSE 事件过滤是高频路径（流式期间每秒上百条），走 TTL 缓存 + sessions-changed
 *   即时失效，不做每条事件的磁盘 IO。
 * - 归档索引损坏 / 偏好读取抛错时降级为「不过滤」，与 /api/state 既有的
 *   「降级保证页面可用，而不是整个接口 500」契约一致；可见性判断永远不抛。
 */

import { canonical } from './session-index';
import type { PiRun, PiSession } from '../../shared/pi';

export interface VisibilitySource {
  sessions(): PiSession[];
  runs(): PiRun[];
  /** 已归档会话 key（archive.list()）；缺失或抛错都视为「无归档索引」降级。 */
  archivedSessions?(): string[] | undefined;
  /** 已移除/隐藏项目路径（hiddenProjects 偏好）；缺失或抛错都视为「无隐藏清单」降级。 */
  hiddenProjects?(): string[] | undefined;
}

export interface VisibilitySnapshot {
  /** 会话记录本身是否可见（/api/state 列表口径）。 */
  sessionVisible(session: Pick<PiSession, 'key' | 'cwd' | 'parentSession' | 'sidecarOf'>): boolean;
  /** 只有一个 key（SSE 的 ui/rpc/closed/compaction-record 事件）时判断可见。 */
  keyVisible(key: string | undefined): boolean;
  /** run 记录是否可见（run 自带 cwd/sidecarOf，key 对应会话尚未落盘也能判）。 */
  runVisible(run: Pick<PiRun, 'key' | 'cwd' | 'sidecarOf'>): boolean;
}

interface SnapshotCache { at: number; view: VisibilitySnapshot }

export class RemoteVisibility {
  private cache: SnapshotCache | null = null;
  constructor(private readonly source: VisibilitySource, private readonly ttlMs = 1_000) {}

  /** 可见性输入可能已变化（归档/移除项目）时调用；sessions-changed 广播即走这里。 */
  invalidate(): void { this.cache = null; }

  /**
   * @param force true = 丢弃缓存现算。/api/state、/api/history 低频且必须反映
   * 最新偏好，用 force；publish 事件过滤走缓存。
   */
  snapshot(force = false): VisibilitySnapshot {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.view;
    const view = this.build();
    this.cache = { at: Date.now(), view };
    return view;
  }

  private build(): VisibilitySnapshot {
    // 每个输入源独立降级：一个坏掉（如归档索引损坏）只放弃那一个过滤维度，
    // 其余口径照常生效——比整体放弃或整体 500 都更接近桌面侧行为。
    const readKeys = (fn?: () => string[] | undefined): Set<string> => {
      try { return new Set((fn?.() ?? []).map(k => String(k))); } catch { return new Set(); }
    };
    const archived = readKeys(this.source.archivedSessions);
    const hidden = new Set([...readKeys(this.source.hiddenProjects)].map(p => canonical(p)));
    const byKey = new Map<string, PiSession>();
    try { for (const s of this.source.sessions()) byKey.set(s.key, s); } catch { /* 扫描失败按空表处理：key 级判断退回 run 信息 */ }
    const runByKey = new Map<string, PiRun>();
    try { for (const r of this.source.runs()) runByKey.set(r.key, r); } catch { /* 同上 */ }

    const sessionVisible: VisibilitySnapshot['sessionVisible'] = (s) => {
      if (archived.has(s.key)) return false;
      if (s.sidecarOf !== undefined) return false; // 副驾（辅助对话）不进手机端
      if (s.parentSession !== undefined) return false; // subagent 内部会话不进手机端
      if (hidden.has(canonical(s.cwd))) return false; // 已移除项目：cwd 可能是别名，canonical 后比对
      return true;
    };
    const keyVisible: VisibilitySnapshot['keyVisible'] = (key) => {
      if (!key) return true; // 无 key 的事件（广播型）不做会话级过滤
      if (archived.has(key)) return false;
      const s = byKey.get(key);
      if (s) return sessionVisible(s);
      const r = runByKey.get(key);
      if (r) {
        if (r.sidecarOf !== undefined) return false;
        if (hidden.has(canonical(r.cwd))) return false;
      }
      // 未知 key 不误杀（宁可多转发）：写路径另有 isRun + backend 校验兜底，
      // 这里过滤的目标是「已移除/内部的记录不得重现」，不是白名单闸门。
      return true;
    };
    const runVisible: VisibilitySnapshot['runVisible'] = (run) => {
      if (run.sidecarOf !== undefined) return false;
      if (archived.has(run.key)) return false;
      if (hidden.has(canonical(run.cwd))) return false;
      const s = byKey.get(run.key);
      if (s && !sessionVisible(s)) return false; // key 落盘后按会话口径补判（parentSession 等）
      return true;
    };
    return { sessionVisible, keyVisible, runVisible };
  }
}
