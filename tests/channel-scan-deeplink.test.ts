import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 钉钉扫码配置：二维码直达开发者后台「创建应用」页（已验证扫码登录后落创建表单），
// 分步指引精确到每一步（Stream 模式、凭据页）。AppSecret 平台不允许第三方代读，
// 复制凭据仍需手动——文案保持诚实。
const source = readFileSync(new URL('../src/renderer/pi/ChannelConfigDialog.tsx', import.meta.url), 'utf8');

describe('钉钉扫码配置直达创建页', () => {
  it('二维码直达开发者后台创建应用页（而非开放平台首页）', () => {
    expect(source).toContain("dingtalk: 'https://open-dev.dingtalk.com/fe/app?opType=create'");
    expect(source).not.toContain("dingtalk: 'https://open.dingtalk.com/'");
  });

  it('钉钉分步指引覆盖：创建表单 → 机器人能力 + Stream 模式 → 凭据复制 → 回填', () => {
    expect(source).toContain('直接落在「创建企业内部应用」表单');
    expect(source).toContain('「机器人」');
    expect(source).toContain('Stream 模式');
    expect(source).toContain('「凭据与基础信息」复制 AppKey 与 AppSecret');
  });

  it('飞书/Telegram 扫码入口保持可达', () => {
    expect(source).toContain("feishu: 'https://open.feishu.cn/app'");
    expect(source).toContain("telegram: 'https://t.me/BotFather'");
  });
});
