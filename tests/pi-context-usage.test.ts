import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ContextUsageDetails } from '../src/renderer/pi/ContextUsage';

it('shows exact usage, capacity and remaining without inventing a plan quota', () => {
  const html = renderToStaticMarkup(createElement(ContextUsageDetails, { usage: { tokens: 267000, contextWindow: 400000, percent: 66.75 }, zh: true, model: 'proxy / model' }));
  expect(html).toContain('267,000 tokens');
  expect(html).toContain('400,000 tokens');
  expect(html).toContain('133,000 tokens');
  expect(html).toContain('66.8%');
  expect(html).toContain('尚未接入供应商');
  expect(html).not.toContain('缓存命中率');
});
it('distinguishes unknown usage after compaction from a real zero', () => {
  const missing = renderToStaticMarkup(createElement(ContextUsageDetails, { usage: {tokens: null, contextWindow: 400000, percent: null}, zh: true }));
  expect(missing).toContain('更新中');
  expect(missing).not.toContain('aria-valuenow');
  const zero = renderToStaticMarkup(createElement(ContextUsageDetails, { usage: {tokens: 0, contextWindow: 400000, percent: 0}, zh: true }));
  expect(zero).toContain('0.0%');
  expect(zero).toContain('aria-valuenow="0"');
});
it('keeps progress within its visual range without hiding actual over-capacity usage', () => {
  const html = renderToStaticMarkup(createElement(ContextUsageDetails, { usage: {tokens: 110, contextWindow: 100, percent: 110}, zh: false }));
  expect(html).toContain('110.0%');
  expect(html).toContain('width:100%');
  expect(html).toContain('0 tokens');
});
