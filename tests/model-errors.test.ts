import { describe, expect, it, vi } from 'vitest';
import { modelErrorPart } from '../src/renderer/pi/model-error';
import { historyToMessages, liveToMessages } from '../src/renderer/pi/adapter';
import { formatErrorChain, redactDiagnosticText, safeRequestTarget } from '../extensions/desktop-policy/diagnostic-text.mjs';
// Runtime extension is native JS and also runs outside the Electron bundle.
// @ts-expect-error runtime JS has no TypeScript declaration
import { wrapDiagnosticFetch } from '../extensions/desktop-policy/network-diagnostics.mjs';

const err = (code: string) => Object.assign(new Error(`connect failed at https://user:pass@example.com/private/secret?api_key=url-secret#frag`), { code });

describe('safe runtime network diagnostics', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])('preserves %s on the original rejected error', async code => {
    const cause = err(code), error = new TypeError('fetch failed', { cause });
    const fetch = wrapDiagnosticFetch(vi.fn().mockRejectedValue(error));
    await expect(fetch('https://user:pass@example.com/v1/responses?token=secret', { method: 'POST', body: 'DO_NOT_INCLUDE_BODY', headers: { Authorization: 'Bearer DO_NOT_INCLUDE_HEADER' } })).rejects.toBe(error);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('TypeError');
    expect(error.message).toContain(code);
    expect(error.message).toContain('Stage: fetch (no response headers received)');
    expect(error.message).toContain('POST https://example.com/v1/responses');
    for (const secret of ['user:pass', 'url-secret', 'api_key=', 'DO_NOT_INCLUDE', '/private/secret', '?token=']) expect(error.message).not.toContain(secret);
  });
  it('preserves response identity, HTTP errors, arguments and this', async () => {
    for (const status of [200, 401, 429, 500]) {
      const response = new Response('untouched body', { status }), ctx = {};
      const original = vi.fn(function (this: unknown) { expect(this).toBe(ctx); return Promise.resolve(response); });
      const fetch = wrapDiagnosticFetch(original), req = new Request('https://example.com/');
      expect(await fetch.call(ctx, req)).toBe(response);
      expect(response.bodyUsed).toBe(false);
      expect(original).toHaveBeenCalledTimes(1);
      expect(original).toHaveBeenCalledWith(req);
      expect(wrapDiagnosticFetch(fetch)).toBe(fetch);
    }
  });
  it('preserves AbortError and frozen error failures', async () => {
    const abort = new DOMException('user cancelled', 'AbortError'), frozen = Object.freeze(new TypeError('fetch failed'));
    for (const e of [abort, frozen]) await expect(wrapDiagnosticFetch(() => Promise.reject(e))('https://example.com')).rejects.toBe(e);
    expect(abort.message).toBe('user cancelled');
    expect(frozen.message).toBe('fetch failed');
  });
  it('handles AggregateError, cycles, unknown thrown values and repeated wrapping', async () => {
    const cause = new AggregateError([err('ECONNREFUSED'), err('ETIMEDOUT')], 'all endpoints failed');
    const error = new TypeError('fetch failed', { cause });
    Object.assign(cause, { cause: error });
    const fetch = wrapDiagnosticFetch(() => Promise.reject(error));
    await expect(fetch('https://example.com')).rejects.toBe(error);
    await expect(fetch('https://example.com')).rejects.toBe(error);
    expect(error.message.match(/\[Desktop network diagnostics\]/g)).toHaveLength(1);
    expect(error.message).toContain('ECONNREFUSED'); expect(error.message).toContain('ETIMEDOUT');
    await expect(wrapDiagnosticFetch(() => Promise.reject('oops'))('https://example.com')).rejects.toBe('oops');
    expect(formatErrorChain(null)).toBe('');
  });
  it('does not invent a code or HTTP status when no cause is provided', async () => {
    const error = new TypeError('fetch failed');
    await expect(wrapDiagnosticFetch(() => Promise.reject(error))('https://example.com')).rejects.toBe(error);
    expect(error.message).not.toMatch(/ECONN|HTTP \d/);
  });
});

describe('model error mapping and redaction', () => {
  it('keeps both live and historical errors, metadata and labelled transport diagnostics', () => {
    const message = {
      role: 'assistant', content: [], provider: 'openai', model: 'test-model', api: 'openai-codex-responses', timestamp: 1700000000000,
      stopReason: 'error', errorMessage: 'fetch failed',
      diagnostics: [{ type: 'codex_websocket_fallback', error: { name: 'Error', message: 'socket failed', code: 'ECONNRESET', cause: { message: 'refused', code: 'ECONNREFUSED' }, stack: 'Error\n at http://user:pass@localhost/custom/SECRET?q=TOKEN' }, details: { phase: 'before_first_stream_event', configuredTransport: 'auto', fallbackTransport: 'sse', eventsEmitted: false, requestBytes: 32, headers: { Authorization: 'UNSAFE_HEADER' }, body: 'UNSAFE_BODY' } }],
    };
    const historic = historyToMessages([{ id: 'e1', type: 'message', message }])[0].parts[0];
    const live = liveToMessages({ m1: message }, [])[0].parts[0];
    expect(historic).toMatchObject({ kind: 'error', context: 'openai / test-model', missingCause: false });
    expect(live).toMatchObject({ ...historic, id: 'm1-err' });
    if (historic.kind !== 'error') throw Error('missing error');
    expect(historic.details).toContain('codex_websocket_fallback');
    expect(historic.details).toContain('phase: before_first_stream_event');
    expect(historic.details).toContain('ECONNREFUSED');
    expect(historic.details).toContain('eventsEmitted: false');
    for (const secret of ['UNSAFE', 'user:pass', '/SECRET', 'TOKEN']) expect(historic.details).not.toContain(secret);
  });
  it('states when legacy generic errors have no underlying cause and never invents one', () => {
    const p = modelErrorPart({ errorMessage: 'fetch failed', provider: 'demo' }, 'err');
    expect(p?.missingCause).toBe(true);
    expect(p?.details).not.toMatch(/ECONN|timeout|401|500/i);
    expect(modelErrorPart({ errorMessage: '429 rate limited' }, 'err')?.missingCause).toBe(false);
    expect(modelErrorPart({ stopReason: 'error' }, 'err')?.message).toContain('no error message');
    expect(modelErrorPart({ stopReason: 'stop' }, 'err')).toBeUndefined();
    expect(modelErrorPart({ stopReason: 'aborted' }, 'err')).toBeUndefined();
  });
  it('redacts credentials before summary, details and copy use; drops arbitrary fields', () => {
    const raw = '401 Unauthorized\nAuthorization: Bearer HEADER_SECRET\nCookie: sid=COOKIE_SECRET\n{"apiKey":"JSON SECRET", "password":"PASS_SECRET", "token":"TOKEN_SECRET"}\nhttps://username:URLPASS@api.example.com/path/PATH_SECRET?key=QUERY_SECRET#HASH_SECRET\nsk-123456789abcdefghijkl';
    const p = modelErrorPart({ errorMessage: raw, diagnostics: [{ type: 'test', error: { message: raw, headers: 'HEADER_FIELD', body: 'BODY_FIELD' }, details: { payload: 'PROMPT_SECRET' } }] }, 'e');
    const json = JSON.stringify(p);
    for (const secret of ['HEADER_SECRET', 'COOKIE_SECRET', 'JSON SECRET', 'PASS_SECRET', 'TOKEN_SECRET', 'URLPASS', 'PATH_SECRET', 'QUERY_SECRET', 'HASH_SECRET', 'sk-123', 'HEADER_FIELD', 'BODY_FIELD', 'PROMPT_SECRET']) expect(json).not.toContain(secret);
    expect(json).toContain('401 Unauthorized');
    expect(json).toContain('[REDACTED]');
    expect(redactDiagnosticText(redactDiagnosticText(raw))).toBe(redactDiagnosticText(raw));
  });
  it('bounds pathological diagnostics and accepts only safe endpoint paths', () => {
    expect(safeRequestTarget('https://user:password@example.com/v1/chat/completions?key=abc')).toBe('https://example.com/v1/chat/completions');
    expect(safeRequestTarget('https://example.com/arbitrary/secret')).toBe('https://example.com/…');
    expect(safeRequestTarget('file:///private/secret')).toBe('[URL omitted]');
    expect(safeRequestTarget('broken')).toBe('[invalid URL]');
    expect(redactDiagnosticText('a'.repeat(20000)).length).toBeLessThan(12100);
    const p = modelErrorPart({ errorMessage: 'x'.repeat(30000), diagnostics: Array(100).fill({ type: 'x', error: { message: 'y'.repeat(30000) } }) }, 'e', Infinity);
    expect(p?.details?.length).toBeLessThan(12100);
  });
});
