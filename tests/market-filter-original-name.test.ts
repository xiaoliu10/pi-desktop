import { describe, expect, it } from 'vitest';
import { filterInstalled, filterMarketplace } from '../src/renderer/replica/plugins/helpers';
import type { MarketplaceCardData, PluginRowData } from '../src/renderer/replica/contracts';

// 场景（2026-10-22 用户实测）：市场搜「pi-lens」只出 fork（description 里提到
// pi-lens 的第三方），本体反而消失——因为显示名剥了 pi- 前缀（pi-lens→lens），
// 客户端过滤只匹配显示名。修复后原始包名（id）必须参与匹配。

function card(overrides: Partial<MarketplaceCardData>): MarketplaceCardData {
  return {
    id: 'unknown-pkg',
    name: 'unknown',
    verified: false,
    publisher: 'someone',
    version: '1.0.0',
    installs: 0,
    description: '',
    permissions: [],
    published: true,
    tags: [],
    ...overrides,
  };
}

const MARKET: MarketplaceCardData[] = [
  card({ id: 'pi-lens', name: 'lens', description: 'Real-time code feedback for pi — LSP, linters, formatters.' }),
  card({ id: '@watercol/pi-lens-simple', name: 'lens-simple', description: 'Unofficial simplified fork of pi-lens for AST tools.' }),
  card({ id: '@dihak/pix-diagnostics', name: 'pix-diagnostics', description: 'Compact session-touched-files widget (overrides pi-lens)' }),
  card({ id: 'pi-memory', name: 'memory', description: 'Memory tools for pi.' }),
];

describe('filterMarketplace 原始包名匹配', () => {
  it('搜「pi-lens」必须命中被美化为「lens」的本体', () => {
    const hits = filterMarketplace(MARKET, 'pi-lens', 'all');
    expect(hits.map((c) => c.id)).toContain('pi-lens');
  });

  it('fork 们靠 description 命中的行为保持不变（不回归）', () => {
    const hits = filterMarketplace(MARKET, 'pi-lens', 'all');
    expect(hits.map((c) => c.id)).toContain('@watercol/pi-lens-simple');
    expect(hits.map((c) => c.id)).toContain('@dihak/pix-diagnostics');
  });

  it('scope 包显示名剥离后仍可按短名搜到（原行为不回归）', () => {
    expect(filterMarketplace(MARKET, 'lens-simple', 'all').map((c) => c.id)).toContain('@watercol/pi-lens-simple');
    expect(filterMarketplace(MARKET, 'memory', 'all').map((c) => c.id)).toContain('pi-memory');
  });

  it('无关词不命中', () => {
    expect(filterMarketplace(MARKET, 'nonexistent', 'all')).toEqual([]);
  });

  it('空 query 返回全部（浏览模式）', () => {
    expect(filterMarketplace(MARKET, '', 'all')).toHaveLength(4);
  });
});

describe('filterInstalled 原始包名匹配', () => {
  const rows: PluginRowData[] = [
    {
      id: 'pkg:pi-lens',
      name: 'lens', // 已装行同样被剥前缀美化
      packageId: 'npm 包',
      version: '4.4.4',
      status: 'active',
      scope: 'everywhere',
    },
  ];

  it('搜「pi-lens」命中已装行（id 含原始包名）', () => {
    expect(filterInstalled(rows, 'pi-lens')).toHaveLength(1);
  });

  it('搜短名「lens」仍命中（原行为不回归）', () => {
    expect(filterInstalled(rows, 'lens')).toHaveLength(1);
  });

  it('无关词不命中', () => {
    expect(filterInstalled(rows, 'nope')).toHaveLength(0);
  });
});
