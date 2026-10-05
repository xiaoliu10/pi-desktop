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
  // 一键配置（应用注册 device flow）失败时的兜底：直达创建页手动建应用。
  dingtalk: 'https://open-dev.dingtalk.com/fe/app?opType=create',
  feishu: 'https://open.feishu.cn/app',
  telegram: 'https://t.me/BotFather',
  wechat: 'https://sct.ftqq.com/',
};

const STEPS: Record<ChannelId, string[]> = {
  dingtalk: [
    '扫码后在钉钉里选择企业并确认授权——应用由钉钉自动创建，凭据自动回填本窗口。',
    '若一键流程失败，按手动步骤：在钉钉开放平台创建企业内部应用，添加「机器人」能力并选「Stream 模式」。',
    '在「凭据与基础信息」复制 AppKey 与 AppSecret，切到「手动配置」填入保存。',
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
  wechat: [
    '用微信扫描二维码（或在电脑浏览器打开 sct.ftqq.com），微信登录后复制页面上的 SendKey。',
    '回到本对话框，在「手动配置」里粘贴 SendKey 并保存。',
    '想用 PushPlus：登录 pushplus.plus 关注公众号并复制 token，推送服务选 PushPlus。',
    '点「发送测试消息」，微信里收到即配置成功。',
  ],
};

const STEPS_EN: Record<ChannelId, string[]> = {
  dingtalk: [
    'Scan, pick your org and approve inside DingTalk — the app is created for you and credentials auto-fill.',
    'If one-click fails, manual path: create an internal app on the open platform, add the "Robot" capability and choose "Stream mode".',
    'Copy AppKey/AppSecret from "Credentials & Basic Info", then paste under Manual.',
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
  wechat: [
    'Scan the QR with WeChat (or open sct.ftqq.com in a browser), log in and copy the SendKey.',
    'Back in this dialog, paste the SendKey under Manual and save.',
    'Prefer PushPlus: log in at pushplus.plus, follow the account, copy the token and pick PushPlus as the service.',
    'Tap "Send test message" — receiving it in WeChat means you are done.',
  ],
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
  // 钉钉一键配置（应用注册 device flow）：扫码 → 钉钉内选企业并确认 → 自动创建应用 →
  // 轮询拿到 AppKey/AppSecret 自动填入。失败/过期降级为静态直达页 + 手动配置。
  const [reg, setReg] = useState<{ url: string; deviceCode: string; userCode: string; expireInMs: number } | null>(null);
  const [regStatus, setRegStatus] = useState<'starting' | 'showing' | 'success' | 'fail' | 'expired' | 'error'>('starting');
  const [regError, setRegError] = useState('');
  const [regQr, setRegQr] = useState<string | null>(null);
  const [regSeconds, setRegSeconds] = useState(0);
  const [regNonce, setRegNonce] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRegTimers = () => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; }
  };

  useEffect(() => {
    cardRef.current?.focus();
    setQr(null);
    setQrErr(false);
    let alive = true;
    const url = channel === 'dingtalk' ? null : SCAN_URLS[channel];
    if (tab === 'scan' && url) {
      qrToDataURL(url, { width: 220, margin: 1 })
        .then(data => { if (alive) setQr(data); })
        .catch(() => { if (alive) setQrErr(true); });
    }
    return () => { alive = false; };
  }, [channel, tab]);

  // 钉钉一键流程：进入扫码 tab 即启动，success 自动填入并保存；卸载/切 tab 清理定时器。
  useEffect(() => {
    // 每轮 effect 用闭包内局部 alive（同文件首个 effect 模式）：dep 变化时先 cleanup
    // （alive=false）再 setup，上一轮 boot 的 continuation 恢复时读到 false 直接 bail，
    // 不会用陈旧 deviceCode 再建定时器（共享 ref 会在新一轮 setup 被重置为 true）。
    let alive = true;
    let consecutiveErrors = 0;
    if (channel !== 'dingtalk' || tab !== 'scan') { stopRegTimers(); return; }
    let deviceCode = '';
    setRegStatus('starting'); setRegError(''); setReg(null); setRegQr(null);
    const boot = async () => {
      try {
        const session = await window.localPi.dingtalkRegister.start();
        if (!alive) return;
        deviceCode = session.deviceCode;
        setReg(session); setRegSeconds(Math.ceil(session.expireInMs / 1000)); setRegStatus('showing');
        qrToDataURL(session.url, { width: 220, margin: 1 })
          .then(data => { if (alive) setRegQr(data); })
          .catch(() => { if (alive) setRegQr(null); });
        tickTimer.current = setInterval(() => setRegSeconds(prev => (prev <= 1 ? 0 : prev - 1)), 1000);
        pollTimer.current = setInterval(async () => {
          try {
            const result = await window.localPi.dingtalkRegister.poll(deviceCode);
            if (!alive) return;
            if (!result.done) {
              // 连续失败上限：非公开 API 被限流/下线时降级到 error UI + 重试，而非无限轮询。
              // 成功轮询归零计数，语义为「连续失败」而非「累计失败」。
              if (!result.error) { consecutiveErrors = 0; return; }
              if (++consecutiveErrors >= 3) { stopRegTimers(); setRegStatus('fail'); setRegError(result.error); }
              return;
            }
            stopRegTimers();
            if (result.status === 'success' && result.clientId && result.clientSecret) {
              // 不落 onImChange：onSave（saveIm）内部用服务端权威合并结果整体刷新父状态，
              // 且避免轮询期间 props.im 陈旧 spread 回写旧值。
              void props.onSave({ appKey: result.clientId, appSecret: result.clientSecret, provider: 'dingtalk', twoWay: true });
              setRegStatus('success');
            } else if (result.status === 'expired') { setRegStatus('expired'); }
            else { setRegStatus('fail'); setRegError(result.error || ''); }
          } catch { if (alive && ++consecutiveErrors >= 3) { stopRegTimers(); setRegStatus('fail'); setRegError(zh ? '网络异常，请重试' : 'Network error, please retry'); } }
        }, session.intervalMs);
      } catch (e) {
        if (!alive) return;
        setRegStatus('error'); setRegError(String((e as Error).message || e));
      }
    };
    void boot();
    return () => { alive = false; stopRegTimers(); };
  }, [channel, tab, regNonce]);

  // 派生：倒计时归零 → 本地先停双 timer 并落过期态（服务端 EXPIRED 仍是权威，本地先停避免无谓请求）。
  // 副作用放在派生 effect 而非 setRegSeconds updater 内（updater 需纯函数，render 阶段不可有副作用）。
  useEffect(() => {
    if (regStatus === 'showing' && regSeconds <= 0) {
      stopRegTimers();
      setRegStatus('expired');
    }
  }, [regSeconds, regStatus]);

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
    dingtalk: zh ? '用钉钉扫码，确认后自动创建应用并填入凭据。' : 'Scan with DingTalk — approve and credentials auto-fill.',
    feishu: zh ? '用飞书扫码打开飞书开放平台。' : 'Scan with Feishu to open the open platform.',
    telegram: zh ? '用 Telegram 扫码打开 @BotFather。' : 'Scan with Telegram to open @BotFather.',
    wechat: zh ? '微信扫码登录 Server酱，复制 SendKey 粘贴到「手动配置」。' : 'Scan to log in to ServerChan, paste the SendKey under Manual.',
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
          {tab === 'scan' && channel === 'dingtalk' && (
            <div className="pi-chdialog__scan">
              {regStatus === 'starting' && <div className="pi-chdialog__qr"><span className="pi-chdialog__qrhint">{zh ? '正在创建配置会话…' : 'Starting…'}</span></div>}
              {regStatus === 'showing' && (
                <>
                  <div className="pi-chdialog__qr">
                    {regQr ? <img src={regQr} alt={zh ? '一键配置二维码' : 'One-click QR'} /> : <span className="pi-chdialog__qrhint">{zh ? '正在生成二维码...' : 'Generating QR…'}</span>}
                  </div>
                  <p className="pi-chdialog__scanhint">{zh ? '用钉钉扫码，在钉钉里选择企业并确认授权——应用会自动创建，凭据自动填入。' : 'Scan with DingTalk, pick your org and approve — the app is created and credentials fill in automatically.'}</p>
                  {reg?.userCode && <p className="pi-chdialog__link">{zh ? '确认码' : 'Code'}: <b className="pi-mono">{reg.userCode}</b></p>}
                  <p className="pi-chdialog__scanhint" aria-live="polite">{zh ? `有效期 ${Math.floor(regSeconds / 60)} 分 ${regSeconds % 60} 秒，过期后点「重新开始」` : `Expires in ${Math.floor(regSeconds / 60)}m ${regSeconds % 60}s — tap "Retry" after it expires`}</p>
                </>
              )}
              {regStatus === 'success' && (
                <div className="pi-chdialog__qr">
                  <span className="pi-chdialog__qrhint">{zh ? '✅ 应用已创建，AppKey/AppSecret 已自动填入并保存。可直接「发送测试消息」验证。' : '✅ App created — credentials filled in and saved.'}</span>
                </div>
              )}
              {(regStatus === 'fail' || regStatus === 'expired' || regStatus === 'error') && (
                <div className="pi-chdialog__qr">
                  <span className="pi-chdialog__qrhint">{zh ? `一键配置未完成${regError ? '：' + regError : ''}。可重试，或用下方直达链接手动创建。` : `One-click failed${regError ? ': ' + regError : ''}.`}</span>
                  <button type="button" className="pi-btn pi-btn--outline" style={{ margin: '10px auto 0', display: 'block' }} onClick={() => setRegNonce(n => n + 1)}>
                    {zh ? '重新开始' : 'Retry'}
                  </button>
                </div>
              )}
              {SCAN_URLS[channel] && <p className="pi-chdialog__link"><a href={SCAN_URLS[channel]} target="_blank" rel="noopener noreferrer">{zh ? '改为手动创建（开发者后台）' : 'Manual creation (dev console)'}</a></p>}
              <details className="pi-chdialog__stepsbox">
                <summary className="pi-chdialog__scanhint">{zh ? '流程说明 / 手动步骤' : 'Flow details / manual steps'}</summary>
                <ol className="pi-chdialog__steps">
                  {guide.map((step, i) => <li key={i}>{step}</li>)}
                </ol>
              </details>
              <p className="pi-chdialog__scannote">{zh ? '一键配置由钉钉应用注册流程完成（应用创建在你自己的企业下）；失败时可用「手动配置」兜底。' : 'One-click uses DingTalk\'s app registration flow; Manual is the fallback.'}</p>
            </div>
          )}

          {tab === 'scan' && channel !== 'dingtalk' && (
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
              {channel !== 'telegram' && channel !== 'wechat' && (
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
              ) : channel === 'wechat' ? (
                <>
                  <label>
                    <span>{zh ? '推送服务' : 'Push service'}</span>
                    <select className="pi-mono" value={im.pushProvider ?? 'serverchan'} onChange={(e) => void props.onSave({ pushProvider: e.target.value as ImConfig['pushProvider'], provider: channel as ImConfig['provider'] })}>
                      <option value="serverchan">Server酱（sct.ftqq.com）</option>
                      <option value="pushplus">PushPlus（pushplus.plus）</option>
                    </select>
                  </label>
                  <label>
                    <span>{(im.pushProvider ?? 'serverchan') === 'pushplus' ? 'Token' : 'SendKey'}{zh ? '（任务通知）' : ' (task notifications)'}</span>
                    <input className="pi-mono" type="password" value={im.botToken ?? ''} placeholder={(im.pushProvider ?? 'serverchan') === 'pushplus' ? 'PushPlus token…' : 'SCT…'} onChange={(e) => props.onImChange({ ...im, botToken: e.target.value })} onBlur={(e) => void props.onSave({ botToken: e.target.value, provider: channel as ImConfig['provider'] })} />
                  </label>
                  <p className="pi-chdialog__scanhint">{zh ? '微信渠道为单向任务通知（完成/出错/等待确认）；双向对话需要微信出站接口，平台暂未提供——钉钉、飞书、Telegram 支持双向。' : 'WeChat is notification-only (done/error/attention); two-way chat needs an outbound API WeChat does not offer — DingTalk, Feishu and Telegram support it.'}</p>
                </>
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
