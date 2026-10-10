/**
 * 应用更新检查（GitHub Releases）：启动后延迟一次 + 每 6 小时静默复查，
 * 有新版本时把状态推给渲染层（侧栏方向符号右侧的绿色下载标）。
 * 网络/限流/解析失败一律静默降级为「无更新」——检查绝不影响主流程。
 */

import type { UpdateStatus } from '../shared/pi';

export type { UpdateStatus };

const DEFAULT_RELEASES_API = 'https://api.github.com/repos/xiaoliu10/pi-desktop/releases/latest';

/** 解析 v0.1.15 / 0.2.0-beta.1 形态；解析失败返回 null（fail closed：不误报更新）。 */
function parseVersion(v: string): { core: [number, number, number]; pre?: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/i.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
}

/** 预发布段按 . 拆段比较，数字段比数值（beta.9 < beta.10），非数字段退化为字符串比。 */
function comparePre(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** latest 是否比 current 新。语义：逐段数值比较；同号时正式版 > 预发布，预发布按段比较。 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (!a.pre && b.pre) return true;
  if (a.pre && !b.pre) return false;
  if (a.pre && b.pre) return comparePre(a.pre, b.pre) > 0;
  return false;
}

interface ReleaseInfo { tag: string; url: string }

/** 拉取最新 release；非 2xx / 草稿 / 预发布 / 字段异常 / 网络失败一律返回 null。 */
async function fetchLatestRelease(apiUrl: string): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pi-desktop-update-check' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null; // 404（无 release）/403（限流）等
    const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
    if (data.draft === true || data.prerelease === true) return null;
    if (typeof data.tag_name !== 'string' || typeof data.html_url !== 'string') return null;
    // 打开地址只信任 github.com 域（数据源本身是 GitHub API，防御纵深）。
    if (!/^https:\/\/github\.com\//.test(data.html_url)) return null;
    return { tag: data.tag_name, url: data.html_url };
  } catch {
    return null;
  }
}

export interface UpdateChecker {
  /** 立即检查一次（不改变周期调度）。解析失败/无网络时返回 available:false 的状态。 */
  checkNow(): Promise<UpdateStatus>;
  /** 最近一次检查结果；首次检查完成前为 undefined。 */
  status(): UpdateStatus | undefined;
  dispose(): void;
}

export function startUpdateChecker(options: {
  currentVersion: string;
  onStatus: (status: UpdateStatus) => void;
  /** 覆盖默认 API 地址（测试注入）。 */
  releasesApi?: string;
  intervalMs?: number;
  initialDelayMs?: number;
}): UpdateChecker {
  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let last: UpdateStatus | undefined;

  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      void checkNow().finally(() => { if (!disposed) schedule(intervalMs); });
    }, delay);
  };

  const checkNow = async (): Promise<UpdateStatus> => {
    const release = await fetchLatestRelease(options.releasesApi ?? DEFAULT_RELEASES_API);
    const status: UpdateStatus = release
      ? {
          available: isNewerVersion(release.tag, options.currentVersion),
          current: options.currentVersion,
          latest: release.tag.replace(/^v/i, ''),
          url: release.url,
          checkedAt: Date.now(),
        }
      : { available: false, current: options.currentVersion, checkedAt: Date.now() };
    if (disposed) return status;
    last = status;
    options.onStatus(status);
    return status;
  };

  schedule(options.initialDelayMs ?? 10_000);
  return {
    checkNow,
    status: () => last,
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); },
  };
}
