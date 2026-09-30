import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccessModeMenu } from '../src/renderer/pi/AccessModeMenu';
import type { AccessMode } from '../src/shared/access-mode';

// 访问模式菜单图标对齐 ZCode（lucide）：plan=灯泡、ask=手掌、autoEdit=方框笔、fullAccess=秒表。
// 用各图标特有的 path 数据断言，防止映射退回旧的 brain/shield 组合。
const MARKERS: Record<AccessMode, string> = {
  plan: 'M15 14c.2-1 .7-1.7 1.5-2.5',          // lightbulb 灯泡轮廓
  ask: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2', // hand 手掌
  autoEdit: 'M18.375 2.625a2.121 2.121 0 1 1 3 3', // square-pen 方框笔
  fullAccess: 'M12 14v-4',                      // timer 秒表指针
};

describe('访问模式菜单图标（ZCode lucide 对齐）', () => {
  it.each(Object.keys(MARKERS) as AccessMode[])('%s 档渲染对应 lucide 图标', mode => {
    const html = renderToStaticMarkup(createElement(AccessModeMenu, { value: mode, disabled: false, changing: false, zh: true, onChange: async () => true }));
    expect(html).toContain(MARKERS[mode]);
  });
  it('旧 brain/shield 图标组合不再出现在任何一档', () => {
    const brainPath = 'M12 5a3 3 0 1 0-5.997.125';
    for (const mode of Object.keys(MARKERS) as AccessMode[]) {
      const html = renderToStaticMarkup(createElement(AccessModeMenu, { value: mode, disabled: false, changing: false, zh: true, onChange: async () => true }));
      expect(html).not.toContain(brainPath);
    }
  });
});
