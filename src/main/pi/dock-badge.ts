// Count distinct background sessions with completions since the user last returned to the app.
export interface DockBadge {
  /** Mark a session with a background completion as unread. */
  taskDone(key: string, focused: boolean, now?: number): void;
  /** 用户回到窗口：清零。 */
  clear(): void;
  count(): number;
}

/** 同一会话在此窗口内重复的 settled 信号只计一次（合成信号/断线重连防抖）。 */
const DEDUPE_MS = 5000;

export function createDockBadge(apply: (text: string) => void): DockBadge {
  const unread = new Set<string>();
  let lastKey = '';
  let lastAt = 0;
  return {
    taskDone(key, focused, now = Date.now()) {
      if (key === lastKey && now - lastAt < DEDUPE_MS) return;
      lastKey = key;
      lastAt = now;
      if (focused || unread.has(key)) return;
      unread.add(key);
      apply(String(unread.size));
    },
    clear() {
      lastKey = '';
      lastAt = 0;
      if (unread.size === 0) return;
      unread.clear();
      apply('');
    },
    count: () => unread.size,
  };
}
