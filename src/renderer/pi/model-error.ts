import type { ErrorPart } from '../replica/contracts';
import { formatErrorChain, redactDiagnosticText } from '../../../extensions/desktop-policy/diagnostic-text.mjs';

/** Whitelist diagnostic fields: never dump an assistant message, request, headers or auth config. */
export function modelErrorPart(message: Record<string, unknown>, id: string, timestamp?: number): ErrorPart | undefined {
  if (!message.errorMessage && message.stopReason !== 'error') return undefined;
  const raw = redactDiagnosticText(message.errorMessage) || 'Model request failed (no error message provided)';
  const model = typeof message.model === 'string' ? message.model : (message.model as { id?: unknown } | undefined)?.id;
  const provider = redactDiagnosticText(message.provider, 200);
  const modelName = redactDiagnosticText(model, 200);
  const metadata = [
    ['Provider', provider], ['Model', modelName], ['API', message.api], ['Stop reason', message.stopReason],
    ['Response ID', message.responseId],
    ['Time', timestamp !== undefined && Number.isFinite(timestamp) && Math.abs(timestamp) < 8.64e15 ? new Date(timestamp).toISOString() : undefined],
  ].flatMap(([key, value]) => {
    const text = redactDiagnosticText(value, 300);
    return text ? [`${key}: ${text}`] : [];
  });
  const diagnostics: string[] = [];
  if (message.error && typeof message.error === 'object') {
    const chain = formatErrorChain(message.error);
    if (chain) diagnostics.push(chain);
  }
  if (Array.isArray(message.diagnostics)) for (const [index, d] of message.diagnostics.slice(0, 8).entries()) {
    if (!d || typeof d !== 'object') continue;
    const lines = [`Diagnostic ${index + 1}: ${redactDiagnosticText(d.type, 150) || 'runtime'}`];
    const chain = formatErrorChain(d.error);
    if (chain) lines.push(chain);
    // Runtime diagnostics may describe an earlier WebSocket failure before SSE fallback,
    // not the terminal request's cause. Preserve labels and phase; never relabel it as root cause.
    if (d.details && typeof d.details === 'object') for (const key of ['phase', 'configuredTransport', 'fallbackTransport', 'eventsEmitted', 'requestBytes', 'status', 'statusCode', 'requestId', 'url', 'endpoint']) {
      const value = d.details[key];
      const text = typeof value === 'boolean' ? String(value) : redactDiagnosticText(value, 500);
      if (text) lines.push(`${key}: ${text}`);
    }
    const stack = redactDiagnosticText(d.error?.stack, 4000);
    if (stack) lines.push(stack);
    diagnostics.push(lines.join('\n'));
  }
  const generic = /^(?:TypeError:\s*)?(?:fetch failed|failed to fetch|connection error\.?|network error\.?)$/i.test(raw.trim());
  return {
    kind: 'error', source: 'model', id, message: raw,
    groupKey: JSON.stringify([provider, modelName, redactDiagnosticText(message.api, 200), raw.split('\n[Desktop network diagnostics]')[0].trim()]),
    context: [provider, modelName].filter(Boolean).join(' / '),
    details: redactDiagnosticText([...metadata, '', 'Error message:', raw, ...diagnostics.map(d => `\n${d}`)].join('\n')),
    missingCause: generic && diagnostics.length === 0,
  };
}
