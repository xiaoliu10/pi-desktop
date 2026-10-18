import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { GlobalSearch } from '../src/renderer/replica/overlays/Overlays';
import { SessionIndex } from '../src/main/pi/session-index';
import { searchOverlayFixtures } from './fixtures/search-overlay';

// 会话内全文搜索 UI 契约：主进程索引层（SessionIndex.searchSession）→ Overlays 渲染。
// 钉住：命中区只在有 selectedKey 且 query 非空时出现；命中回显 preview + role；
// 点击走 onSelectEntry（定位 entryId）；会话列表区不受影响。
const labels = { placeholder: '搜索', newTask: '新建任务', today: '最近', noResults: '无结果', commands: '命令', messages: '消息', settings: '设置' };

describe('session search overlay', () => {
  it('renders in-session hits with previews and routes clicks by entryId', () => {
    const { hits, total } = searchOverlayFixtures();
    const clicked: string[] = [];
    const html = renderToStaticMarkup(
      React.createElement(GlobalSearch, {
        open: true, query: '菊花', items: [{ id: 's1', kind: 'session', title: '性能治理会话', source: '会话', at: 1 }], demo: false, labels,
        onQuery: () => undefined, onClose: () => undefined, onSelect: () => undefined,
        selectedKey: 'key-1', entryHits: hits, entryTotal: total, onSelectEntry: (id: string) => clicked.push(id),
      }),
    );
    expect(html).toContain('会话内');
    expect(html).toContain(`${total} 条命中`);
    expect(html).toContain('runningSubagentCounts');
    expect(html).toContain('aria-label="会话内搜索结果"');
    expect(html).toContain('pi');
  });

  it('hides the in-session section without a selected key', () => {
    const { hits, total } = searchOverlayFixtures();
    const html = renderToStaticMarkup(
      React.createElement(GlobalSearch, {
        open: true, query: '菊花', items: [], demo: false, labels,
        onQuery: () => undefined, onClose: () => undefined, onSelect: () => undefined,
        entryHits: hits, entryTotal: total, onSelectEntry: () => undefined,
      }),
    );
    expect(html).not.toContain('会话内搜索结果');
    expect(html).not.toContain('条命中');
  });

  it('shows the searching state and empty state', () => {
    const labelsZh = { ...labels, noResults: '无结果' };
    const searching = renderToStaticMarkup(
      React.createElement(GlobalSearch, {
        open: true, query: 'x', items: [], demo: false, labels: labelsZh, selectedKey: 'k',
        onQuery: () => undefined, onClose: () => undefined, onSelect: () => undefined,
        entrySearching: true, entryHits: [], entryTotal: 0, onSelectEntry: () => undefined,
      }),
    );
    expect(searching).toContain('会话内搜索中');
    const empty = renderToStaticMarkup(
      React.createElement(GlobalSearch, {
        open: true, query: 'x', items: [], demo: false, labels: labelsZh, selectedKey: 'k',
        onQuery: () => undefined, onClose: () => undefined, onSelect: () => undefined,
        entryHits: [], entryTotal: 0, onSelectEntry: () => undefined,
      }),
    );
    expect(empty).toContain('会话内无匹配');
  });
});
