/**
 * Workspace settings pane, laid out after the ZCode mobile-remote screen:
 * a large QR card ("等待手机连接" → connected) with stop / regenerate / copy
 * actions, then Bot Channel cards. Viewer is strictly read-only; the bot is
 * outbound-only. Channels we cannot support without a vendor app are listed
 * but visibly unavailable instead of rendering dead links.
 */

import { useEffect, useRef, useState } from 'react';
import type { ImConfig, RemoteStatus } from '../../shared/pi';
import { usePiStore } from './adapter';

const api = () => window.localPi;

type ChannelId = 'dingtalk' | 'feishu' | 'wechat' | 'telegram';

export function RemotePane() {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const [remote, setRemote] = useState<RemoteStatus>({ running: false, urls: [], viewers: 0 });
  const [qr, setQr] = useState<string | null>(null);
  const [im, setIm] = useState<ImConfig | null>(null);
  const [channel, setChannel] = useState<ChannelId>('dingtalk');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api().remoteStatus().then(setRemote).catch(() => undefined);
    void api().imConfig().then(setIm).catch(() => undefined);
  }, []);

  // Live viewer count while the server is on.
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

  const showQr = async (status: RemoteStatus) => {
    setRemote(status);
    if (status.running && status.urls[0]) {
      const QR = await import('qrcode');
      setQr(await QR.toDataURL(status.urls[0], { width: 240, margin: 1 }));
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
      say(zh ? '已生成新二维码，旧链接已失效' : 'New QR generated; old links revoked');
    } catch (e) {
      say(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    say(zh ? '已复制' : 'Copied');
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

  const connected = remote.running && (remote.viewers ?? 0) > 0;

  return (
    <section className="pi-settings__block pi-remote">
      <h2 className="pi-settings__blocktitle">{zh ? '移动端远程控制' : 'Mobile remote'}</h2>
      <div className="pi-settingrow pi-settingrow__desc" style={{ padding: 0, border: 'none', background: 'transparent' }}>
        <span>{zh ? '扫码或在手机上打开链接，即可在浏览器只读查看当前工作区。' : 'Scan or open the link on your phone to watch this workspace, read-only.'}</span>
      </div>

      <div className={`pi-remote__card ${remote.running ? 'pi-remote__card--on' : ''}`}>
        {remote.running ? (
          <>
            <div className="pi-remote__qrside">
              {qr && <img className="pi-remote__qr" src={qr} alt="QR" />}
              <div className={`pi-remote__state ${connected ? 'pi-remote__state--on' : ''}`}>
                {connected
                  ? (zh ? `已连接 ${remote.viewers} 台设备` : `Connected · ${remote.viewers} device(s)`)
                  : (zh ? '等待手机连接…' : 'Waiting for a phone…')}
              </div>
            </div>
            <div className="pi-remote__actions">
              <div className="pi-remote__hint">{zh ? '用手机相机扫码，或在手机上打开链接。' : 'Scan with your phone camera or open the link on the phone.'}</div>
              <div className="pi-remote__btns">
                <button className="pi-btn pi-btn--primary" onClick={() => void copy(remote.urls[0] ?? '')}>{zh ? '复制链接' : 'Copy link'}</button>
                <button className="pi-btn pi-btn--outline" disabled={busy} onClick={() => void regenerate()}>{zh ? '刷新二维码' : 'New QR'}</button>
                <button className="pi-btn pi-btn--outline" disabled={busy} onClick={() => void toggle()}>{zh ? '停止' : 'Stop'}</button>
              </div>
              <div className="pi-remote__urls">
                {remote.urls.map((u) => (
                  <button key={u} className="pi-btn pi-btn--ghost pi-mono pi-remote__url" title={zh ? '点击复制链接' : 'Copy link'} onClick={() => void copy(u)}>
                    {u}
                  </button>
                ))}
              </div>
              <div className="pi-settingrow__desc">{zh ? '无法扫码？复制上方链接在手机浏览器打开。严格只读，停止后令牌立即失效。' : 'Cannot scan? Copy the link above. Strictly read-only; tokens die on stop.'}</div>
            </div>
          </>
        ) : (
          <div className="pi-remote__off">
            <div className="pi-remote__placeholder" aria-hidden="true">{zh ? '二维码' : 'QR'}</div>
            <div className="pi-remote__hint" style={{ textAlign: 'center' }}>{zh ? '开启后在此显示二维码，手机扫码即可查看工作区。' : 'Start to show a QR code for your phone.'}</div>
            <button className="pi-btn pi-btn--primary" disabled={busy} onClick={() => void toggle()}>{zh ? '开启' : 'Start'}</button>
          </div>
        )}
      </div>

      <h2 className="pi-settings__blocktitle" style={{ marginTop: 22 }}>{zh ? '使用 Bot Channel' : 'Bot channels'}</h2>
      <div className="pi-settingrow__desc" style={{ padding: 0 }}>
        <span>{zh ? '连接聊天 Bot，在 IM 里接收任务完成 / 出错 / 等待确认的通知。' : 'Receive task completed / failed / awaiting-confirmation notices in your chat app.'}</span>
      </div>
      <div className="pi-remote__channels">
        {channels.map((c) => (
          <button
            key={c.id}
            className={`pi-remote__channel ${channel === c.id && c.available ? 'pi-remote__channel--on' : ''} ${c.available ? '' : 'pi-remote__channel--off'}`}
            onClick={() => {
              if (!c.available) return;
              setChannel(c.id);
              if (im && im.provider !== c.id) void saveIm({ provider: c.id as ImConfig['provider'] });
              formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }}
            disabled={!c.available}
          >
            <span className="pi-remote__channelname">{c.name}</span>
            <span className="pi-remote__channelhint">{c.hint}</span>
            <span className="pi-remote__channelpact">{c.available ? (zh ? '去配置' : 'Configure') : (zh ? '暂不支持' : 'Unavailable')}</span>
          </button>
        ))}
      </div>
      {im && (channel === 'dingtalk' || channel === 'feishu' || channel === 'telegram') && (
        <div ref={formRef} className="pi-providerform">
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
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn pi-btn--primary" disabled={busy} onClick={() => { void saveIm({ provider: channel }); void api().imTest().then(() => say(zh ? '测试消息已发送，请到群里查看' : 'Test sent')).catch((e) => say(String((e as Error).message || e))); }}>
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
