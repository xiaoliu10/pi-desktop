/** `/api/history` tail 分页窗口：返回 [start, end) 与「是否还有更早」标记。
 *  - 不带 before：取分支末尾最近 page 条（默认最近 50）。
 *  - before=N：取 N 之前的 page 条（更早的一页），end 先 clamp 到 [0, len]。
 *  非数值 / 空字符串 before 视作缺省（默认 tail），避免把脏参当 0 读出空页。
 *  返回的 start 同时是「取下一页更早历史」要用的游标（?before=start）。纯函数，
 *  便于直接单测；HTTP 层与可见性守卫在其外包裹。
 *
 *  独立成模块（而非留在 remote-server）是因为会话索引 worker 也要用它计算分页：
 *  worker 不该为了一个纯函数把整个 HTTP/SSE 服务模块拉进进程。 */
export const HISTORY_PAGE_SIZE = 50;

export function historyWindow(len: number, beforeParam: string | null, page = HISTORY_PAGE_SIZE): { start: number; end: number; hasMore: boolean } {
  const total = Number.isFinite(len) && len > 0 ? Math.floor(len) : 0;
  let end = total;
  if (beforeParam !== null && beforeParam !== '') {
    const n = Number(beforeParam);
    if (Number.isFinite(n)) end = Math.max(0, Math.min(total, Math.floor(n)));
  }
  const start = Math.max(0, end - page);
  return { start, end, hasMore: start > 0 };
}
