// Dock 角标（macOS Dock 图标右上角的红色数字，参考 ZCode 的完成提示）：
// 后台任务（一轮 agent 运行）完成时 +1，用户回到窗口自动清零。
// 纯逻辑模块：Electron 的 apply 回调注入，便于单测。
export interface DockBadge {
  /** 一轮运行结束。key=会话 key（同一会话短窗内重复 settled 去重）；focused=窗口是否在前台。 */
  taskDone(key: string, focused: boolean, now?: number): void;
  /** 用户回到窗口：清零。 */
  clear(): void;
  count(): number;
}

/** 同一会话在此窗口内重复的 settled 信号只计一次（合成信号/断线重连防抖）。 */
const DEDUPE_MS = 5000;

export function createDockBadge(apply: (text: string) => void): DockBadge {
  let count = 0;
  let lastKey = '';
  let lastAt = 0;
  return {
    taskDone(key, focused, now = Date.now()) {
      if (key === lastKey && now - lastAt < DEDUPE_MS) return;
      lastKey = key;
      lastAt = now;
      if (focused) return; // 用户正看着窗口，无需角标提醒
      count += 1;
      apply(String(count));
    },
    clear() {
      lastKey = '';
      lastAt = 0;
      if (count === 0) return;
      count = 0;
      apply('');
    },
    count: () => count,
  };
}
