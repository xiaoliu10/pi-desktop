import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../../src/main/pi/session-index';

// 用合成会话走一遍真实索引层（不 mock）：命中来自 searchSession 本身。
export function searchOverlayFixtures(): { hits: ReturnType<SessionIndex['searchSession']>['hits']; total: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-'));
  const file = path.join(dir, 's.jsonl');
  const entries = [
    { type: 'session', version: 3, id: 's', cwd: dir },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-18T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: '侧栏菊花不转' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-18T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '根因在 runningSubagentCounts 的菊花计数，需要 refreshRunningSubagents 修正' }] } },
  ];
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const index = new SessionIndex([dir], dir);
  const key = index.scan()[0].key;
  return index.searchSession(key, '菊花');
}
