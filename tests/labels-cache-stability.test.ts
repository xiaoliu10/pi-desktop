import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 性能回归护栏（docs/design/input-lag.md 切片 1）：
// labelsFor 必须跨调用返回同一引用——否则每次 render 新建的 labels 对象会击穿
// ChatView / Composer / Sidebar 等所有 memo 子组件，流式期间（150ms 一拍的
// streamFlush）整棵树重渲染，表现为「打字卡」。
//
// 用源码文本断言实现契约（labelsFor 在 PiReplicaApp 模块内未导出，浏览器测试
// 成本高；源码结构断言对这类「引用稳定性」契约是可靠且可回归的形式）。

const SRC = fs.readFileSync(path.resolve(__dirname, '../src/renderer/pi/PiReplicaApp.tsx'), 'utf8');

describe('labelsFor 模块级缓存（renderer memo 击穿防护）', () => {
  it('labelsFor 带缓存包装，buildLabels 做实际构造', () => {
    expect(SRC).toMatch(/const labelsCache = new Map<'en' \| 'zh', ReturnType<typeof buildLabels>>\(\)/);
    expect(SRC).toMatch(/function labelsFor\(lang: 'en' \| 'zh'\): ReturnType<typeof buildLabels> \{/);
    expect(SRC).toMatch(/const cached = labelsCache\.get\(lang\);\s*\n\s*if \(cached\) return cached;/);
    expect(SRC).toMatch(/const built = buildLabels\(lang\);\s*\n\s*labelsCache\.set\(lang, built\);/);
    // 构造逻辑在 buildLabels 里（不引用缓存 → 无循环类型推断）
    expect(SRC).toMatch(/function buildLabels\(lang: 'en' \| 'zh'\) \{/);
  });
  it('根组件 labels 消费保持 t.chat / t.composer / t.topbar / t.sidebar / t.plugins 形状（缓存不得改契约）', () => {
    for (const key of ['t.chat', 't.composer', 't.topbar', 't.sidebar', 't.plugins']) {
      expect(SRC).toContain(key);
    }
  });
});
