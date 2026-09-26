/**
 * 内置浏览器（工作台 browser tab）的纯逻辑：地址栏输入归一化 + 视口尺寸预设。
 * 独立成模块以便 vitest 单测（不依赖 Electron / DOM）。
 */

export type NormalizeResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'protocol' | 'invalid' };

/** 裸主机输入时本机/内网地址默认 http（开发服务器通常无 TLS），公网域名默认 https。 */
const LOCAL_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[?::1\]?|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i;

function parseHttp(url: string): NormalizeResult {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return { ok: false, reason: 'invalid' };
    return { ok: true, url: parsed.href };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * 地址栏输入 → 可导航 URL。
 * - 完整 http(s) URL 原样保留（含端口/路径/查询）；
 * - 其它带 scheme 的输入（file:、javascript:、data: …）一律拒绝；
 * - 裸域名自动补 https://，localhost / IP 自动补 http://。
 */
export function normalizeUrl(raw: string): NormalizeResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (/\s/.test(text)) return { ok: false, reason: 'invalid' };
  if (/^https?:\/\//i.test(text)) return parseHttp(text);
  // scheme 判定：冒号后是数字视为 host:port（localhost:3000），否则按 scheme 拒绝（javascript:/data:/file:）。
  const scheme = text.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:(.*)$/);
  if (scheme && !/^\d+([/?#]|$)/.test(scheme[1])) return { ok: false, reason: 'protocol' };
  return parseHttp(`${LOCAL_HOST.test(text) ? 'http' : 'https'}://${text}`);
}

export interface ViewportPreset {
  id: string;
  width?: number;
  height?: number;
}

/** 视口尺寸预设：fit = 适应窗口（填满面板）；其余为固定尺寸（容器可滚动查看）。 */
export const VIEWPORTS: ViewportPreset[] = [
  { id: 'fit' },
  { id: '1440x900', width: 1440, height: 900 },
  { id: '1280x800', width: 1280, height: 800 },
  { id: '1024x768', width: 1024, height: 768 },
  { id: '390x844', width: 390, height: 844 },
];

export function viewportById(id: string): ViewportPreset {
  return VIEWPORTS.find((preset) => preset.id === id) ?? VIEWPORTS[0];
}
