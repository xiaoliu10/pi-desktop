// 渠道品牌图标（对齐 ZCode）：素材拷自 ZCode desktop app.asar
// （dingding/feishu/telegram/weixin @2x PNG，官方钉钉/飞书/Telegram/微信图标）。
// 经 vite 打包为静态资源 URL，避开手搓 SVG 的形似问题。
// DO NOT EDIT MANUALLY — regenerate from ZCode asar if ZCode updates these icons.
import dingtalkUrl from './dingtalk.png';
import feishuUrl from './feishu.png';
import telegramUrl from './telegram.png';
import wechatUrl from './wechat.png';

export const CHANNEL_ICON_URLS: Record<string, string> = {
  dingtalk: dingtalkUrl,
  feishu: feishuUrl,
  telegram: telegramUrl,
  wechat: wechatUrl,
};
