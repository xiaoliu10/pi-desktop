/**
 * Bot Channel 配置对话框（ZCode 机器人配置对齐）：点击渠道行弹出，支持两种配置方式——
 * ①扫码配置：渠道专属二维码（钉钉/飞书开放平台、Telegram BotFather）+ 分步准备指引，
 *   扫码后在平台侧创建机器人，凭据仍回此处手动填写（ZCode telegramBotFather 同款模式）；
 * ②手动配置：直接填写凭据（Webhook/加签密钥/AppKey/AppSecret/Bot Token）+ 通知开关 + 测试。
 * 表单状态由父组件（RemotePane）持有：onSave 即时保存（onBlur/勾选），onTest 发测试消息。
 */

import { useEffect, useRef, useState } from 'react';
// 与 RemotePane 同口径：静态导入避免 qrcode 被拆成动态 chunk（其 browser build 与主
// bundle 循环依赖，打包 app 里 import() 会 reject——见 RemotePane.tsx 顶部注释）。
import { toDataURL as qrToDataURL } from 'qrcode';
import type { ImConfig } from '../../shared/pi';
import { CHANNEL_ICON_URLS } from './brand-icons/channel-icons';
import { Icon } from '../replica/Icons';

export type ChannelId = 'dingtalk' | 'feishu' | 'wechat' | 'telegram';

const SCAN_URLS: Record<ChannelId, string> = {
  // 钉钉直达开发者后台「创建应用」表单（扫码登录后免导航）；AppSecret 为机密，
  // 平台不允许第三方代读，复制凭据仍需手动。
  dingtalk: 'https://open-dev.dingtalk.com/fe/app?opType=create',
  feishu: 'https://open.feishu.cn/app',
  telegram: 'https://t.me/BotFather',
  wechat: '',
};

const STEPS: Record<ChannelId, string[]> = {
  dingtalk: [
    '用钉钉扫码登录，直接落在「创建企业内部应用」表单，填个应用名即可创建。',
    '左侧「添加应用能力」勾选「机器人」；「机器人配置」里消息接收模式选「Stream 模式」。',
    '左侧「凭据与基础信息」复制 AppKey 与 AppSecret。',
    '回到本对话框切到「手动配置」，把 AppKey/AppSecret 填入并保存。',
  ],
  feishu: [
    '用飞书扫码打开飞书开放平台，创建自建应用并开启机器人能力。',
    '在凭据页复制 App ID 与 App Secret。',
    '在任意群聊添加自定义机器人，获取 Webhook 与加签密钥（通知与测试消息走这条通道）。',
    '回到本对话框切到「手动配置」，把凭据填入并保存。',
  ],
  telegram: [
    '用 Telegram 扫码打开 @BotFather，发送 /newbot 创建机器人。',
    '复制 BotFather 返回的 HTTP API Token。',
    '回到本对话框切到「手动配置」，粘贴 Bot Token 并保存。',
  ],
  wechat: [],
};

const STEPS_EN: Record<ChannelId, string[]> = {
  dingtalk: [
    'Scan with DingTalk to sign in — you land directly on the "Create internal app" form; just name it.',
    'Add the "Robot" capability under the app; set the message receiving mode to "Stream mode".',
    'Copy the AppKey and AppSecret from "Credentials & Basic Info".',
    'Back in this dialog, switch to Manual and paste the credentials.',
  ],
  feishu: [
    'Scan with Feishu to open the Feishu open platform; create a custom app with bot capability.',
    'Copy the App ID and App Secret from the credentials page.',
    'Add a custom bot webhook in any group chat to get the Webhook URL and signing secret (notifications and test messages use it).',
    'Back in this dialog, switch to Manual and paste the credentials.',
  ],
  telegram: [
    'Scan with Telegram to open @BotFather and send /newbot to create a bot.',
    'Copy the HTTP API token returned by BotFather.',
    'Back in this dialog, switch to Manual and paste the Bot Token.',
  ],
  wechat: [],
};

export function ChannelConfigDialog(props: {
  channel: ChannelId;
  name: string;
  hint: string;
  zh: boolean;
  im: ImConfig;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: Partial<ImConfig>) => Promise<void>;
  onImChange: (im: ImConfig) => void;
  onTest: () => void;
}) {
  const { channel, zh, im, busy } = props;
  const [tab, setTab] = useState<'scan' | 'manual'>('scan');
  const [qr, setQr] = useState<string | null>(null);
  const [qrErr, setQrErr] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
    setQr(null);
    setQrErr(false);
    let alive = true;
    const url = SCAN_URLS[channel];
    if (tab === 'scan' && url) {
      qrToDataURL(url, { width: 220, margin: 1 })
        .then(data => { if (alive) setQr(data); })
        .catch(() => { if (alive) setQrErr(true); });
    }
    return () => { alive = false; };
  }, [channel, tab]);

  // Esc + Tab 焦点圈禁用 window 级监听：点击 card 内非可聚焦区域后焦点落回 body，
  // card 级 onKeyDown 冒泡不到（仓库惯例，同 OpenWithMenu）；卸载时归还焦点到触发元素。
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { props.onClose(); return; }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusables = cardRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); restore?.focus?.(); };
  }, []);

  const scanHint: Record<ChannelId, string> = {
    dingtalk: zh ? '用钉钉扫码登录，直达「创建应用」页。' : 'Scan with DingTalk to land on the app creation page.',
    feishu: zh ? '用飞书扫码打开飞书开放平台。' : 'Scan with Feishu to open the open platform.',
    telegram: zh ? '用 Telegram 扫码打开 @BotFather。' : 'Scan with Telegram to open @BotFather.',
    wechat: zh ? '暂未支持' : 'Not yet supported',
  };
  const guide = zh ? STEPS[channel] : STEPS_EN[channel];

  return (
    <div className="pi-chdialog" role="dialog" aria-modal="true" aria-label={props.name} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="pi-chdialog__card" ref={cardRef} tabIndex={-1}>
        <header className="pi-chdialog__head">
          <span className="pi-remote__channelicon"><img src={CHANNEL_ICON_URLS[channel]} alt="" width={22} height={22} /></span>
          <h2>{props.name}</h2>
          {im.provider === channel && <span className="pi-remote__channelbadge">{zh ? '已配置' : 'Configured'}</span>}
          <button type="button" className="pi-iconbtn" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose}>×</button>
        </header>
        <p className="pi-chdialog__hint">{props.hint}</p>

        <div className="pi-chdialog__tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'scan'} className={`pi-chdialog__tab ${tab === 'scan' ? 'pi-chdialog__tab--on' : ''}`} onClick={() => setTab('scan')}>
            <Icon name="smartphone" size={14} />{zh ? '扫码配置' : 'Scan'}
          </button>
          <button role="tab" aria-selected={tab === 'manual'} className={`pi-chdialog__tab ${tab === 'manual' ? 'pi-chdialog__tab--on' : ''}`} onClick={() => setTab('manual')}>
            <Icon name="edit-files" size={14} />{zh ? '手动配置' : 'Manual'}
          </button>
        </div>

        <div className="pi-chdialog__body">
          {tab === 'scan' && (
            <div className="pi-chdialog__scan">
              <div className="pi-chdialog__qr">
                {qr ? <img src={qr} alt={zh ? '配置二维码' : 'Setup QR code'} /> : qrErr ? (
                  <span className="pi-chdialog__qrhint">{zh ? '二维码生成失败，可直接打开下方链接' : 'QR failed; open the link below'}</span>
                ) : (
                  <span className="pi-chdialog__qrhint">{zh ? '正在生成二维码...' : 'Generating QR…'}</span>
                )}
              </div>
              <p className="pi-chdialog__scanhint">{scanHint[channel]}</p>
              {SCAN_URLS[channel] && <p className="pi-chdialog__link"><a href={SCAN_URLS[channel]} target="_blank" rel="noopener noreferrer">{SCAN_URLS[channel]}</a></p>}
              <ol className="pi-chdialog__steps">
                {guide.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
              <p className="pi-chdialog__scannote">{zh ? '扫码只是打开平台侧的创建页面；凭据仍需在「手动配置」里填写。' : 'Scanning opens the platform page; paste credentials under Manual.'}</p>
            </div>
          )}

          {tab === 'manual' && (
            <div className="pi-providerform pi-chdialog__form">
              {channel !== 'telegram' && (
                <>
                  <label>
                    <span>Webhook</span>
                    <input className="pi-mono" value={im.webhook} placeholder={channel === 'dingtalk' ? 'https://oapi.dingtalk.com/robot/send?access_token=…' : 'https://open.feishu.cn/open-apis/bot/v2/hook/…'} onChange={(e) => props.onImChange({ ...im, webhook: e.target.value })} onBlur={(e) => void props.onSave({ webhook: e.target.value, provider: channel as ImConfig['provider'] })} />
                  </label>
                  <label>
                    <span>{zh ? '加签密钥（可选）' : 'Sign secret (optional)'}</span>
                    <input className="pi-mono" value={im.secret ?? ''} onChange={(e) => props.onImChange({ ...im, secret: e.target.value })} onBlur={(e) => void props.onSave({ secret: e.target.value })} />
                  </label>
                </>
              )}
              {channel === 'telegram' ? (
                <label>
                  <span>Bot Token</span>
                  <input className="pi-mono" value={im.botToken ?? ''} placeholder="123456:ABC-DEF…" onChange={(e) => props.onImChange({ ...im, botToken: e.target.value })} onBlur={(e) => void props.onSave({ botToken: e.target.value, provider: channel as ImConfig['provider'] })} />
                </label>
              ) : (
                <>
                  <label>
                    <span>{channel === 'dingtalk' ? 'AppKey' : 'App ID'}{zh ? '（双向对话）' : ' (two-way chat)'}</span>
                    <input className="pi-mono" value={im.appKey ?? ''} onChange={(e) => props.onImChange({ ...im, appKey: e.target.value })} onBlur={(e) => void props.onSave({ appKey: e.target.value, provider: channel as ImConfig['provider'] })} />
                  </label>
                  <label>
                    <span>App Secret</span>
                    <input className="pi-mono" type="password" value={im.appSecret ?? ''} onChange={(e) => props.onImChange({ ...im, appSecret: e.target.value })} onBlur={(e) => void props.onSave({ appSecret: e.target.value })} />
                  </label>
                  <label className="pi-providerform__check">
                    <input type="checkbox" checked={Boolean(im.twoWay)} onChange={(e) => void props.onSave({ twoWay: e.target.checked })} />
                    <span>{zh ? '开启双向对话（出站长连接，无需公网服务器）' : 'Enable two-way chat (outbound long connection)'}</span>
                  </label>
                </>
              )}
              <label className="pi-providerform__check">
                <input type="checkbox" checked={im.notifyCompleted} onChange={(e) => void props.onSave({ notifyCompleted: e.target.checked })} />
                <span>{zh ? '任务完成时通知' : 'Notify on completion'}</span>
              </label>
              <label className="pi-providerform__check">
                <input type="checkbox" checked={im.notifyError} onChange={(e) => void props.onSave({ notifyError: e.target.checked })} />
                <span>{zh ? '任务出错时通知' : 'Notify on errors'}</span>
              </label>
              <label className="pi-providerform__check">
                <input type="checkbox" checked={im.notifyAttention} onChange={(e) => void props.onSave({ notifyAttention: e.target.checked })} />
                <span>{zh ? '等待确认时通知' : 'Notify when awaiting confirmation'}</span>
              </label>
            </div>
          )}
        </div>

        <footer className="pi-chdialog__foot">
          <button className="pi-btn pi-btn--primary" disabled={busy} onClick={() => { void props.onSave({ provider: channel as ImConfig['provider'] }); props.onTest(); }}>
            {zh ? '发送测试消息' : 'Send test message'}
          </button>
          <button className="pi-btn pi-btn--outline" onClick={props.onClose}>{zh ? '完成' : 'Done'}</button>
        </footer>
        <em className="pi-chdialog__note">
          {zh
            ? '双向对话命令：/帮助 /状态 /新建 /项目 /模型 /模式 /思考 /bind；直接发文字即下达任务指令。工具确认仍会在桌面端弹出。'
            : 'Two-way commands: /help /status /new /workspace /model /mode /thinking /bind; plain text goes to the task.'}
        </em>
      </div>
    </div>
  );
}
