import { describe, expect, it } from 'vitest';
import { normalizeUrl, viewportById, VIEWPORTS } from '../src/renderer/replica/workbench/browser-utils';

describe('normalizeUrl', () => {
  it('keeps complete http/https URLs as-is', () => {
    expect(normalizeUrl('https://example.com/a?b=1#c')).toEqual({ ok: true, url: 'https://example.com/a?b=1#c' });
    expect(normalizeUrl('http://192.168.1.10:8080/dev')).toEqual({ ok: true, url: 'http://192.168.1.10:8080/dev' });
    expect(normalizeUrl('  https://example.com  ')).toEqual({ ok: true, url: 'https://example.com/' });
  });

  it('prepends https:// to bare public hosts', () => {
    expect(normalizeUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' });
    expect(normalizeUrl('example.com/docs?q=x')).toEqual({ ok: true, url: 'https://example.com/docs?q=x' });
    expect(normalizeUrl('sub.example.co.uk:8443')).toEqual({ ok: true, url: 'https://sub.example.co.uk:8443/' });
  });

  it('prepends http:// to localhost and IP hosts (dev servers usually lack TLS)', () => {
    expect(normalizeUrl('localhost:3000')).toEqual({ ok: true, url: 'http://localhost:3000/' });
    expect(normalizeUrl('localhost')).toEqual({ ok: true, url: 'http://localhost/' });
    expect(normalizeUrl('127.0.0.1:5173')).toEqual({ ok: true, url: 'http://127.0.0.1:5173/' });
    expect(normalizeUrl('10.20.30.201:8080/ui')).toEqual({ ok: true, url: 'http://10.20.30.201:8080/ui' });
  });

  it('rejects non-web protocols', () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x/y', 'chrome://settings', 'about:blank']) {
      expect(normalizeUrl(raw)).toEqual({ ok: false, reason: 'protocol' });
    }
  });

  it('rejects empty and malformed input', () => {
    expect(normalizeUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeUrl('hello world')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeUrl('https://')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('viewport presets', () => {
  it('fit is the default and fixed presets carry dimensions', () => {
    expect(viewportById('fit')).toEqual({ id: 'fit' });
    expect(viewportById('1440x900')).toEqual({ id: '1440x900', width: 1440, height: 900 });
    expect(viewportById('390x844')).toEqual({ id: '390x844', width: 390, height: 844 });
    expect(viewportById('nonsense').id).toBe('fit');
    expect(VIEWPORTS[0].id).toBe('fit');
  });
});
