import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 钉钉一键配置（应用注册 device flow）上线后，深链是失败兜底：直达开发者后台
// 「创建应用」页（已验证扫码登录后落创建表单），手动步骤指引精确到每一步
// （Stream 模式、凭据页）。一键失败时用户可改走手动路径。
const source = readFileSync(new URL('../src/renderer/pi/ChannelConfigDialog.tsx', import.meta.url), 'utf8');

describe('钉钉扫码配置直达创建页', () => {
  it('二维码直达开发者后台创建应用页（而非开放平台首页）', () => {
    expect(source).toContain("dingtalk: 'https://open-dev.dingtalk.com/fe/app?opType=create'");
    expect(source).not.toContain("dingtalk: 'https://open.dingtalk.com/'");
  });

  it('钉钉一键配置流程：扫码确认自动建应用回填凭据；手动步骤作为兜底保留', () => {
    expect(source).toContain('应用由钉钉自动创建，凭据自动回填本窗口');
    expect(source).toContain('Stream 模式');
    expect(source).toContain('「凭据与基础信息」复制 AppKey 与 AppSecret');
    expect(source).toContain('切到「手动配置」填入保存');
  });

  it('飞书/Telegram 扫码入口保持可达', () => {
    expect(source).toContain("feishu: 'https://open.feishu.cn/app'");
    expect(source).toContain("telegram: 'https://t.me/BotFather'");
  });
});
