/**
 * 移动端远程控制面板，完全参考 ZCode WebRemoteControl 布局：
 * 左右双栏（扫码卡 | Bot 频道卡），状态胶囊 + 虚线框居中 QR + 频道列表带图标。
 */

import { useEffect, useRef, useState } from 'react';
import type { ImConfig, RemoteStatus } from '../../shared/pi';
import { usePiStore } from './adapter';
import { Icon } from '../replica/Icons';

const api = () => window.localPi;

type ChannelId = 'dingtalk' | 'feishu' | 'wechat' | 'telegram';
type RemoteState = 'idle' | 'starting' | 'running' | 'connecting' | 'active' | 'error';

export function RemotePane() {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const [remote, setRemote] = useState<RemoteStatus>({ running: false, urls: [], viewers: 0 });
  const [qr, setQr] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [im, setIm] = useState<ImConfig | null>(null);
  const [channel, setChannel] = useState<ChannelId>('dingtalk');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api().remoteStatus().then(setRemote).catch(() => undefined);
    void api().imConfig().then(setIm).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!remote.running) return;
    const timer = window.setInterval(() => {
      void api().remoteStatus().then(setRemote).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [remote.running]);

  const say = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(null), 3500);
  };

  const state: RemoteState = !remote.running ? 'idle' : (remote.viewers ?? 0) > 0 ? 'active' : 'running';

  const statusInfo: { label: string; detail: string; dot: string } = {
    idle: { label: zh ? '未开启' : 'Idle', detail: zh ? '等待连接。' : 'Ready to connect.', dot: 'var(--pi-text-tertiary)' },
    starting: { label: zh ? '启动中' : 'Starting', detail: zh ? '正在启动远程控制...' : 'Starting remote control...', dot: 'var(--pi-orange)' },
    running: { label: zh ? '等待手机连接' : 'Waiting for phone', detail: zh ? '用手机扫码，或在手机上打开链接。' : 'Scan the QR code or open the link on your phone.', dot: 'var(--pi-orange)' },
    connecting: { label: zh ? '正在连接手机' : 'Connecting phone', detail: zh ? '手机正在连接...' : 'Phone is connecting...', dot: 'var(--pi-blue)' },
    active: { label: zh ? '手机已连接' : 'Phone connected', detail: zh ? '手机可以控制当前工作区。' : 'Your phone can control this workspace.', dot: '#0a7d33' },
    error: { label: zh ? '连接失败' : 'Connection failed', detail: zh ? '无法启动移动端远程控制。' : 'Could not start mobile remote control.', dot: 'var(--pi-red)' },
  }[state];

  const showQr = async (status: RemoteStatus) => {
    setRemote(status);
    if (status.running && status.urls[0]) {
      try {
        setQrBusy(true);
        const QR = await import('qrcode');
        setQr(await QR.toDataURL(status.urls[0], { width: 256, margin: 1 }));
      } catch { setQr(null); }
      finally { setQrBusy(false); }
    } else {
      setQr(null);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      await showQr(remote.running ? await api().remoteStop() : await api().remoteStart());
    } catch (e) {
      say(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    try {
      await api().remoteStop();
      await showQr(await api().remoteStart());
      say(zh ? '已刷新远程控制二维码' : 'Remote control QR refreshed');
    } catch (e) {
      say(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say(zh ? '已复制远程控制链接' : 'Remote control link copied');
    } catch (e) {
      say(zh ? `复制远程控制链接失败：${(e as Error).message}` : `Could not copy: ${(e as Error).message}`);
    }
  };

  const saveIm = async (patch: Partial<ImConfig>) => {
    if (!im) return;
    setBusy(true);
    try {
      setIm(await api().imSave(patch));
      say(zh ? '已保存' : 'Saved');
    } catch (e) {
      say(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const channels: Array<{ id: ChannelId; name: string; hint: string; available: boolean }> = [
    { id: 'dingtalk', name: '钉钉', hint: zh ? '双向对话（Stream）+ 群通知' : 'Two-way (Stream) + notifications', available: true },
    { id: 'feishu', name: zh ? '飞书' : 'Feishu / Lark', hint: zh ? '双向对话（长连接·实验）+ 群通知' : 'Two-way (experimental) + notifications', available: true },
    { id: 'telegram', name: 'Telegram', hint: zh ? '双向对话（长轮询）· 需可访问 Telegram' : 'Two-way (long-polling)', available: true },
    { id: 'wechat', name: zh ? '微信' : 'WeChat', hint: zh ? '暂未支持' : 'Not yet supported', available: false },
  ];

  const channelIcon = (id: ChannelId) => id === 'telegram' ? 'globe' : 'terminal';
  // 渠道品牌图标（对齐 ZCode：钉钉蓝、飞书双色、微信绿、Telegram 蓝）
  function ChannelGlyph({ id }: { id: ChannelId }) {
    if (id === 'dingtalk') return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><rect width="24" height="24" rx="5.5" fill="#0089FF"/><path d="M17.9 10.1c-.1-.3-.4-.5-.7-.4l-7.4 1.7c-.5.1-.9.5-.9 1.1 0 .4.2.7.6.9l1.7.9-3 3.1c-.3.3-.3.8 0 1.1.3.3.8.3 1.1 0l3-3.1 1 1.7c.2.4.6.6 1 .6h.2c.5-.1.9-.4 1-.9l1.8-6c0-.3-.1-.5-.4-.6z" fill="#fff"/><path d="M8.3 8.2l6.9-1.6c.4-.1.6-.5.5-.9-.1-.4-.5-.6-.9-.5L7.9 6.8c-.4.1-.6.5-.5.9.1.4.5.6.9.5z" fill="#fff" opacity=".92"/></svg>;
    if (id === 'feishu') return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><path d="M4.1 14C6.5 8.5 12.1 4.7 18.7 4c.9-.1 1.6.8 1.3 1.6l-3.7 11c-.2.7-1.1 1-1.6.5l-3.2-2-4 3.5c-.6.5-1.5.2-1.6-.6l-.9-3.4c0-.2.1-.5.3-.6z" fill="#3370FF"/><path d="M11.5 15.4 19 5.2c.3.2.4.5.3.8l-3.5 10.6c-.2.5-.8.7-1.2.4l-3.1-1.6z" fill="#00D6B9"/></svg>;
    if (id === 'wechat') return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><rect width="24" height="24" rx="5.5" fill="#07C160"/><path d="M9.6 5.4c-3.1 0-5.6 2-5.6 4.6 0 1.5.8 2.8 2.1 3.7l-.5 1.8 2-1.1c.6.2 1.3.3 2 .3h.4c-.1-.4-.2-.8-.2-1.3 0-2.5 2.4-4.5 5.4-4.5h.3c-.6-2-3-3.5-5.9-3.5zM7.6 8.1c.4 0 .8.4.8.8 0 .5-.4.8-.8.8-.5 0-.8-.3-.8-.8 0-.4.3-.8.8-.8zm4 0c.4 0 .8.4.8.8 0 .5-.4.8-.8.8-.5 0-.8-.3-.8-.8 0-.4.3-.8.8-.8z" fill="#fff"/><path d="M20.2 14.9c0-2.1-2.1-3.9-4.6-3.9S11 12.8 11 14.9s2.1 3.9 4.6 3.9c.5 0 1-.1 1.5-.2l1.7.9-.4-1.6c1.1-.7 1.8-1.8 1.8-3zm-6.1-.6c.4 0 .7.3.7.6 0 .4-.3.7-.7.7-.3 0-.6-.3-.6-.7 0-.3.3-.6.6-.6zm3.1 0c.3 0 .6.3.6.6 0 .4-.3.7-.6.7-.4 0-.7-.3-.7-.7 0-.3.3-.6.7-.6z" fill="#fff"/></svg>;
    return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="10" fill="#2AABEE"/><path d="m5.6 11.6 11.8-4.5c.6-.2 1.2.3 1 .9l-2 9.5c-.1.6-.8.9-1.3.5l-2.8-2.1-1.5 1.5c-.3.3-.9.2-1-.2l-.9-2.9-3.2-1.1c-.6-.2-.6-1.1-.1-1.6z" fill="#fff"/></svg>;
  }

  return (
    <section className="pi-remote">
      {/* 头部：图标 + 标题 + 描述 */}
      <div className="pi-remote__header">
        <div className="pi-remote__headericon"><Icon name="smartphone" size={20} /></div>
        <div className="pi-remote__headertext">
          <h2 className="pi-remote__title">{zh ? '移动端远程控制' : 'Mobile remote control'}</h2>
          <p className="pi-remote__desc">{zh ? '扫码或在手机上打开链接，即可远程控制当前工作区。' : 'Scan the QR code or open the link on your phone to control this workspace.'}</p>
        </div>
      </div>

      {/* 主区域：左右双栏 */}
      <div className="pi-remote__grid">
        {/* 左：扫码卡 */}
        <section className="pi-remote__scancard">
          <div className="pi-remote__subhead">
            <Icon name="info" size={16} />
            <div className="pi-remote__subheadtext">
              <div className="pi-remote__subheadtitle">{zh ? '手机扫码连接' : 'Scan from phone'}</div>
              <p className="pi-remote__subheaddesc">{zh ? '用手机相机扫码打开：查看实时对话、发送消息、审批工具调用、停止任务（仅限局域网）。' : 'Scan with your phone camera: watch live conversation, send messages, approve tool calls, stop tasks (LAN only).'}</p>
            </div>
          </div>

          {/* 状态条 */}
          <div className="pi-remote__statusbar">
            <div className="pi-remote__statusleft">
              <div className="pi-remote__statusvalue">
                <span className="pi-remote__statuslabelval">{zh ? '会话状态' : 'Session status'}</span>
                <span className="pi-remote__pill">
                  <span className="pi-remote__pill-dot" style={{ background: statusInfo.dot }} />
                  <span className="pi-remote__pill-text">{statusInfo.label}</span>
                </span>
              </div>
              <div className="pi-remote__statusdetail">{statusInfo.detail}</div>
            </div>
            {remote.running ? (
              <button className="pi-btn pi-btn--outline pi-remote__stopbtn" disabled={busy} onClick={() => void toggle()}>
                <Icon name="x" size={14} />{zh ? '停止' : 'Stop'}
              </button>
            ) : (
              <button className="pi-btn pi-btn--primary pi-remote__startbtn" disabled={busy} onClick={() => void toggle()}>
                <Icon name="smartphone" size={14} />{zh ? '开启' : 'Start'}
              </button>
            )}
          </div>

          {/* 复制链接行 */}
          {remote.running && (
            <div className="pi-remote__linkrow">
              <span className="pi-remote__linkdesc">{zh ? '无法扫码？可以在手机上打开链接。' : "Can't scan? Open the link on your phone."}</span>
              <div className="pi-remote__linkbtns">
                <button className="pi-btn pi-btn--outline" disabled={busy} onClick={() => void regenerate()}>
                  <Icon name="refresh" size={14} />{zh ? '刷新二维码' : 'Refresh QR'}
                </button>
                <button className="pi-btn pi-btn--outline" disabled={!remote.urls[0] || busy} onClick={() => void copy(remote.urls[0] ?? '')}>
                  <Icon name="copy" size={14} />{zh ? '复制链接' : 'Copy link'}
                </button>
              </div>
            </div>
          )}

          {/* QR 区 */}
          <div className="pi-remote__qrarea">
            {qr ? (
              <img className="pi-remote__qrimg" src={qr} alt={zh ? 'Web 远程控制二维码' : 'Web remote control QR code'} />
            ) : remote.running ? (
              <div className="pi-remote__qrgenerating">
                <Icon name="loader" size={20} />
                <span>{zh ? '正在准备二维码...' : 'Preparing QR code...'}</span>
              </div>
            ) : (
              <div className="pi-remote__qridle">
                <Icon name="smartphone" size={32} />
                <span>{zh ? '开启后在此显示二维码' : 'Start to show a QR code'}</span>
              </div>
            )}
          </div>
        </section>

        {/* 右：Bot 频道卡 */}
        <section className="pi-remote__botcard">
          <div className="pi-remote__subhead">
            <Icon name="terminal" size={16} />
            <div className="pi-remote__subheadtext">
              <div className="pi-remote__subheadtitle">{zh ? '使用 Bot Channel' : 'Use a bot channel'}</div>
              <p className="pi-remote__subheaddesc">{zh ? '连接聊天 Bot，适合更长时间的移动端访问。' : 'Connect a chat bot for longer-running mobile access.'}</p>
            </div>
          </div>

          <div className="pi-remote__channellist">
            {channels.map((c) => {
              const configured = im && im.provider === c.id;
              return (
                <button
                  key={c.id}
                  className={`pi-remote__channelitem ${channel === c.id && c.available ? 'pi-remote__channelitem--on' : ''} ${c.available ? '' : 'pi-remote__channelitem--off'}`}
                  onClick={() => {
                    if (!c.available) return;
                    setChannel(c.id);
                    if (im && im.provider !== c.id) void saveIm({ provider: c.id as ImConfig['provider'] });
                    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  }}
                  disabled={!c.available}
                >
                  <span className="pi-remote__channelicon"><ChannelGlyph id={c.id} /></span>
                  <span className="pi-remote__channelbody">
                    <span className="pi-remote__channelname">
                      <span className="pi-remote__channelnametext">{c.name}</span>
                      {configured && <span className="pi-remote__channelbadge">{zh ? '已配置' : 'Configured'}</span>}
                    </span>
                    <span className="pi-remote__channelhint">{c.hint}</span>
                    <span className="pi-remote__channelpact">{c.available ? (zh ? '去配置' : 'Configure') : (zh ? '暂不支持' : 'Unavailable')}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {/* 表单区 */}
      {im && (channel === 'dingtalk' || channel === 'feishu' || channel === 'telegram') && (
        <div ref={formRef} className="pi-providerform pi-remote__form">
          {channel !== 'telegram' && (
            <>
              <label>
                <span>Webhook</span>
                <input className="pi-mono" value={im.webhook} placeholder={channel === 'dingtalk' ? 'https://oapi.dingtalk.com/robot/send?access_token=…' : 'https://open.feishu.cn/open-apis/bot/v2/hook/…'} onChange={(e) => setIm({ ...im, webhook: e.target.value })} onBlur={(e) => void saveIm({ webhook: e.target.value, provider: channel })} />
              </label>
              <label>
                <span>{zh ? '加签密钥（可选）' : 'Sign secret (optional)'}</span>
                <input className="pi-mono" value={im.secret ?? ''} onChange={(e) => setIm({ ...im, secret: e.target.value })} onBlur={(e) => void saveIm({ secret: e.target.value })} />
              </label>
            </>
          )}
          {channel === 'telegram' ? (
            <label>
              <span>Bot Token</span>
              <input className="pi-mono" value={im.botToken ?? ''} placeholder="123456:ABC-DEF…" onChange={(e) => setIm({ ...im, botToken: e.target.value })} onBlur={(e) => void saveIm({ botToken: e.target.value, provider: channel })} />
            </label>
          ) : (
            <>
              <label>
                <span>{channel === 'dingtalk' ? 'AppKey' : 'App ID'}{zh ? '（双向对话）' : ' (two-way chat)'}</span>
                <input className="pi-mono" value={im.appKey ?? ''} onChange={(e) => setIm({ ...im, appKey: e.target.value })} onBlur={(e) => void saveIm({ appKey: e.target.value, provider: channel })} />
              </label>
              <label>
                <span>{channel === 'dingtalk' ? 'App Secret' : 'App Secret'}</span>
                <input className="pi-mono" type="password" value={im.appSecret ?? ''} onChange={(e) => setIm({ ...im, appSecret: e.target.value })} onBlur={(e) => void saveIm({ appSecret: e.target.value })} />
              </label>
              <label className="pi-providerform__check">
                <input type="checkbox" checked={Boolean(im.twoWay)} onChange={(e) => void saveIm({ twoWay: e.target.checked })} />
                <span>{zh ? '开启双向对话（出站长连接，无需公网服务器）' : 'Enable two-way chat (outbound long connection)'}</span>
              </label>
            </>
          )}
          <label className="pi-providerform__check">
            <input type="checkbox" checked={im.notifyCompleted} onChange={(e) => void saveIm({ notifyCompleted: e.target.checked })} />
            <span>{zh ? '任务完成时通知' : 'Notify on completion'}</span>
          </label>
          <label className="pi-providerform__check">
            <input type="checkbox" checked={im.notifyError} onChange={(e) => void saveIm({ notifyError: e.target.checked })} />
            <span>{zh ? '任务出错时通知' : 'Notify on errors'}</span>
          </label>
          <label className="pi-providerform__check">
            <input type="checkbox" checked={im.notifyAttention} onChange={(e) => void saveIm({ notifyAttention: e.target.checked })} />
            <span>{zh ? '等待确认时通知' : 'Notify when awaiting confirmation'}</span>
          </label>
          <div className="pi-remote__formbtns">
            <button className="pi-btn pi-btn--primary" disabled={busy} onClick={() => { void saveIm({ provider: channel }); void api().imTest().then(() => say(zh ? '测试消息已发送，请到群里查看' : 'Test sent')).catch((e) => say(String((e as Error).message || e))); }}>
              {zh ? '发送测试消息' : 'Send test message'}
            </button>
          </div>
          <em className="pi-providerform__hint">
            {zh
              ? '双向对话命令：/帮助 /状态 /新建 /项目 /模型 /模式 /思考 /bind；直接发文字即下达任务指令。工具确认仍会在桌面端弹出。'
              : 'Two-way commands: /help /status /new /workspace /model /mode /thinking /bind; plain text goes to the task.'}
          </em>
        </div>
      )}
      {msg && <div className="pi-banner" role="status" style={{ position: 'static', marginTop: 10 }}>{msg}</div>}
    </section>
  );
}
