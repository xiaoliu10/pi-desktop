import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import { canonical } from './session-index';

/**
 * Session continuation map: 「编辑已发送消息」触发 pi 的 fork RPC——pi 把后续对话
 * 写进一个新 session 文件（ISO 前缀 + parentSession 首行），旧文件成为只读快照。
 * Desktop 在此记录 旧文件 → 新文件 的延续关系，使侧栏只呈现一条会话、且点击
 * 旧条目时自动打开最新延续（历史完整：fork 拷贝了全部条目）。
 *
 * 判别约定：map 的 **value** 一定是 desktop 记录的 fork 产物；subagent 子会话
 * （也带 parentSession）不会是 value，二者据此区分。
 */
export type ContinuationMap = Record<string, string>;

export function continuationsFile(dataDir: string): string {
  return path.join(dataDir, 'session-continuations.json');
}

export function loadContinuations(dataDir?: string): ContinuationMap {
  if (!dataDir) return {};
  try {
    const raw = JSON.parse(readFileSync(continuationsFile(dataDir), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as ContinuationMap : {};
  } catch { return {}; }
}

export function saveContinuations(dataDir: string, map: ContinuationMap): void {
  try { writeFileSync(continuationsFile(dataDir), JSON.stringify(map, null, 2) + '\n'); } catch { /* 只读盘位不影响会话 */ }
}

/** 记录一次延续：old → new。链式压缩：所有此前指向 old（或 old 的旧值）的条目直接指向 new。 */
export function recordContinuation(map: ContinuationMap, oldPath: string, newPath: string): ContinuationMap {
  const from = canonical(oldPath);
  const to = canonical(newPath);
  if (from === to) return map;
  const next: ContinuationMap = {};
  for (const [k, v] of Object.entries(map)) {
    // 指向旧链尾的条目与新条目一并改指 latest，避免多级 fork 后需要逐级跳转。
    next[k] = v === from ? to : v;
  }
  next[from] = to;
  return next;
}

/** 解析链尾：path →（存在映射且目标文件真实存在时的）最新延续文件。 */
export function resolveContinuation(map: ContinuationMap, path: string): string {
  let current = canonical(path);
  for (let guard = 0; guard < 8; guard++) {
    const next = map[current];
    if (!next || next === current || !existsSync(next)) break;
    current = next;
  }
  return current;
}

export interface SessionLike { path: string; name: string; parentSession?: string }

/**
 * 会话列表合并（sidebar/index 数据源）：
 * - 被延续的旧快照（map 的 key）隐藏——它们是只读快照，点击会被 connect 重定向，列表里多余；
 * - 延续产物（map 的 value，desktop 记录的 fork 产物）顶层化（清 parentSession，
 *   避免被渲染层 subagent 过滤误伤）并继承链头名字（用户 rename 优先）；
 * - subagent 子会话不可能是 value → 不受影响，仍由渲染层按 parentSession 过滤。
 * 不改动缓存对象：需要修改的条目浅拷贝后替换（scan 返回的是 SessionIndex 缓存的同引用对象）。
 */
export function applyContinuations<T extends SessionLike>(sessions: T[], map: ContinuationMap, renames: Record<string, string>,
  keyOf: (s: T) => string, nameFallback: string): T[] {
  if (Object.keys(map).length === 0) return sessions;
  const byPath = new Map(sessions.map(s => [canonical(s.path), s] as const));
  const sources = new Set(Object.keys(map).map(canonical));
  const targets = new Set(Object.values(map).map(canonical));
  // 链头回溯（沿 parentSession 走到根）：延续条目继承根条目的名字。
  const chainHeadName = (startPath: string): string | undefined => {
    let current = startPath;
    for (let guard = 0; guard < 8; guard++) {
      const parent = byPath.get(current)?.parentSession;
      if (!parent) break;
      const parentPath = canonical(parent);
      if (!byPath.has(parentPath)) break;
      current = parentPath;
    }
    return byPath.get(current)?.name;
  };
  const out: T[] = [];
  for (const s of sessions) {
    const p = canonical(s.path);
    if (sources.has(p)) continue; // 被延续的旧快照：不进列表
    if (targets.has(p)) {
      // 延续产物：名字继承（用父链回溯）后顶层化。浅拷贝，避免污染 SessionIndex 缓存。
      const inherited = chainHeadName(p);
      const fork: T = { ...s, parentSession: undefined };
      fork.name = renames[keyOf(s)] ?? inherited ?? s.name ?? nameFallback;
      out.push(fork);
      continue;
    }
    out.push(s);
  }
  return out;
}
