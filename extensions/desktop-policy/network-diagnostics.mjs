import { formatErrorChain, redactDiagnosticText, safeRequestTarget } from './diagnostic-text.mjs';
const WRAPPED = Symbol.for('pi-desktop.network-diagnostics');

/** Enhance only this rejected fetch; no global last-error state or cross-request correlation. */
export function wrapDiagnosticFetch(fetchImpl) {
  if (fetchImpl[WRAPPED]) return fetchImpl;
  const wrapped = async function (...args) {
    try {
      return await Reflect.apply(fetchImpl, this, args);
    } catch (error) {
      // Cancellation must retain its original identity/name/message and retry semantics.
      if (error && typeof error === 'object' && error.name !== 'AbortError') {
        try {
          if (typeof error.message === 'string' && !error.message.includes('\n[Desktop network diagnostics]')) {
            const [input, init] = args;
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
            const method = String(init?.method || input?.method || 'GET').toUpperCase();
            const chain = formatErrorChain(error);
            const message = redactDiagnosticText(error.message, 3000);
            error.message = [message, '[Desktop network diagnostics]',
              'Stage: fetch (no response headers received)',
              `Request: ${/^[A-Z]{3,12}$/.test(method) ? method : '[method omitted]'} ${safeRequestTarget(url)}`,
              chain,
            ].filter(Boolean).join('\n');
          }
        } catch { /* Diagnostics must never replace the original failure. */ }
      }
      throw error;
    }
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped;
}
export function installNetworkDiagnostics() {
  if (typeof globalThis.fetch === 'function') globalThis.fetch = wrapDiagnosticFetch(globalThis.fetch);
}
