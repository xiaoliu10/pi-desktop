/** Shared by the runtime and renderer. Never serialize requests, headers or arbitrary error objects. */
const MAX_TEXT = 12000;
export function safeRequestTarget(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return '[URL omitted]';
    // Custom proxy paths can contain credentials. Only retain known API endpoint paths.
    const path = /^\/(?:v\d+\/)?(?:chat\/completions|responses|messages)$/.test(u.pathname)
      || /^\/(?:backend-api\/)?codex\/responses$/.test(u.pathname) ? u.pathname : (u.pathname === '/' ? '/' : '/…');
    return `${u.origin}${path}`;
  } catch { return '[invalid URL]'; }
}
export function redactDiagnosticText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let text = String(value);
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  text = text.replace(/(?:https?|wss?):\/\/[^\s<>"'\\]+/gi, url => safeRequestTarget(url));
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
  // Quoted JSON values may contain whitespace; unquoted header values run to end-of-line.
  text = text.replace(/(["']?(?:authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi, '$1[REDACTED]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
}
export function formatErrorChain(error) {
  const lines = [], seen = new Set();
  const visit = (value, label, depth) => {
    if (lines.length >= 16 || depth > 5 || value == null) return;
    if (typeof value !== 'object') {
      const text = redactDiagnosticText(value, 1500);
      if (text) lines.push(`${label}: ${text}`);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    const name = redactDiagnosticText(value.name, 100);
    const code = redactDiagnosticText(value.code, 100);
    const message = redactDiagnosticText(value.message, 1500);
    if (name || code || message) lines.push(`${label}: ${name || 'Error'}${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`);
    if (value.cause) visit(value.cause, 'Caused by', depth + 1);
    if (Array.isArray(value.errors)) for (const e of value.errors.slice(0, 6)) visit(e, 'Aggregate cause', depth + 1);
  };
  visit(error, 'Error', 0);
  return redactDiagnosticText(lines.join('\n'));
}
