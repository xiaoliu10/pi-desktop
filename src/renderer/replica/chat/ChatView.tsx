import { TerminalOutput } from './TerminalOutput';
import { officialSubagentDetails, SubagentNavigation } from '../../pi/subagents';
/**
 * Chat replica components (U03): markdown rendering, tool cards, diffs,
 * message nav rail, composer with menus, and the conversation/home views.
 */

import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ChatMessage,
  ChatViewProps,
  PiImage,
  ComposerProps,
  DemoFileDiff,
  MessagePart,
  ModelGroup,
  ToolPart,
} from '../contracts';
import { Icon, PiBrandMark, type IconName } from '../Icons';
import { FileIcon } from '../FileIcon';
import {
  applyMenuSelection,
  filterCommands,
  filterFiles,
  parseMenuState,
} from './helpers';
import './chat.css';
import { toolFilePreview } from '../../pi/tool-file-preview';
import { executionTurns, formatElapsed, type ChatTurn } from './execution';

const remarkGfmPlugins = [remarkGfm];

/** 记忆化：文本不变时不重新解析 markdown（避免每次按键/流式更新都重解析全部消息）。 */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const content = useMemo(() => <ReactMarkdown remarkPlugins={remarkGfmPlugins}>{text}</ReactMarkdown>, [text]);
  return <div className="pi-md">{content}</div>;
});

export function DiffBlock({ diff, hideHead }: { diff: DemoFileDiff; hideHead?: boolean }) {
  return (
    <div className="pi-diff">
      {!hideHead && (
        <div className="pi-diff__head">
          <span className="pi-diff__path">{diff.path}</span>
          {diff.created && <span className="pi-chip pi-chip--new">new</span>}
          <span className="pi-diff__stat pi-diff__stat--add">+{diff.additions}</span>
          <span className="pi-diff__stat pi-diff__stat--del">−{diff.deletions}</span>
        </div>
      )}
      <div className="pi-diff__body">
        {diff.lines.map((l, i) => (
          <div key={i} className={`pi-diff__line pi-diff__line--${l.type === ' ' ? 'ctx' : l.type === '+' ? 'add' : 'del'}`}>
            <span className="pi-diff__num">{l.line ?? ''}</span>
            <span className="pi-diff__sign">{l.type}</span>
            <span className="pi-diff__text">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolCard({ part, labels, onOpenToolFile }: { part: ToolPart; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile'] }) {
  const openSubagents=useContext(SubagentNavigation);
  const zh = labels.you === '你';
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(part.argumentsText || '{}') || {}; } catch { /* Older sessions may only contain a summary. */ }
  const file = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : typeof args.filePath === 'string' ? args.filePath : '';
  const fileName = file.split('/').pop() || file;
  const directory = file.slice(0, -fileName.length);
  const command = typeof args.command === 'string' ? args.command : undefined;
  const icon = ['bash','run_command'].includes(part.tool) ? 'terminal' : ['grep','find','ls'].includes(part.tool) ? 'search' : ['edit','write'].includes(part.tool) ? 'pencil' : part.tool === 'read' ? 'book' : 'plug';
  const toolLabel = zh ? ({ read: '读取', bash: '终端', run_command: '终端', edit: '编辑', write: '写入', grep: '查阅', find: '查阅', ls: '查阅' } as Record<string, string>)[part.tool] : undefined;
  const statusLabel = part.phase === 'call' ? (part.status === 'running' ? (zh ? '等待执行结果' : 'Awaiting result') : (zh ? '未记录结果' : 'No saved result')) : part.status === 'running' ? labels.toolRunning : part.status === 'error' ? labels.toolError : labels.toolDone;
  // 摘要行上的行数统计：write 用 content 行数（+N），edit 用 edits[] 的 old/new 行数（+N/−M）。
  let additions = 0, deletions = 0;
  if (part.tool === 'write' && typeof args.content === 'string') additions = args.content ? args.content.split('\n').length : 0;
  else if (part.tool === 'edit') {
    const edits = Array.isArray(args.edits) ? args.edits : undefined;
    const count = (s: unknown) => typeof s === 'string' && s ? s.split('\n').length : 0;
    if (edits) for (const e of edits) { if (!e || typeof e !== 'object') continue; deletions += count((e as { oldText?: unknown }).oldText); additions += count((e as { newText?: unknown }).newText); }
    else { deletions += count(args.oldText ?? args.old_string); additions += count(args.newText ?? args.new_string); }
  }
  return (
    <div className={`pi-tool ${part.status === 'error' ? 'pi-tool--error' : ''}`}>
      <details>
        <summary className="pi-tool__summary">
          <Icon name={icon} size={17} />
          <span className="pi-tool__name">{toolLabel || part.tool}</span>
          {file && <span className="pi-tool__file-icon" aria-hidden="true"><FileIcon path={file} size={17} /></span>}
          <span className="pi-tool__arg" title={file || command || part.summary}>{file ? <>{onOpenToolFile && toolFilePreview(part) ? <button type="button" className="pi-tool__file-link" title={toolFilePreview(part)?.current ? '在右侧查看文件及变更' : '在右侧查看本次文件修改'} onClick={event=>{event.preventDefault();event.stopPropagation();onOpenToolFile(part);}}>{fileName}</button> : fileName}<span className="pi-tool__directory">{directory}</span></> : command || part.summary}</span>
          {(additions > 0 || deletions > 0) && <span className="pi-tool__stat">{additions > 0 && <span className="pi-tool__stat--add">+{additions}</span>}{deletions > 0 && <span className="pi-tool__stat--del">−{deletions}</span>}</span>}
          <span className={`pi-tool__status pi-tool__status--${part.status}`}>
            {statusLabel}
          </span>
          <Icon name="chevron-right" size={12} className="pi-execution__chevron" />
        </summary>
        {officialSubagentDetails(part)&&openSubagents&&<button type="button" className="pi-btn pi-btn--ghost" onClick={()=>openSubagents(part.callId||part.id)}>查看子代理任务与过程</button>}
        <div className="pi-tool__detail">
          {part.argumentsText && !['bash','run_command'].includes(part.tool) && <><h4>{zh ? '调用参数' : 'Input'}</h4><pre className="pi-tool__output">{part.argumentsText}</pre></>}
          {(() => {
            // pi 的 bash/run_command 结果把命令以 `$ <命令>` 回显在首行，真实 stdout 跟在后面。
            // 命令已在上方摘要行展示，输出区剥掉这行回显只留 stdout；干净通过则提示无输出。
            const isShell = ['bash','run_command'].includes(part.tool);
            let out = part.detailLines?.join('\n') ?? '';
            if (isShell) {
              const lines = out.split('\n');
              if (lines.length && lines[0].startsWith('$ ')) { lines.shift(); out = lines.join('\n').replace(/^\n+/, ''); }
            }
            if (isShell) return <TerminalOutput command={command} output={out} running={part.status === 'running'}/>;
            if (part.phase === 'call') return <p className="pi-execution__hint">{zh ? '尚无执行结果记录。' : 'No execution result has been recorded yet.'}</p>;
            if (!out.trim() && part.detailLines?.length) return <p className="pi-execution__hint">{zh ? '无文本输出。' : 'No text output.'}</p>;
            if (out.trim()) return <><h4>{zh ? '执行输出' : 'Output'}</h4><pre className="pi-tool__output">{out}</pre></>;
            return null;
          })()}
          {part.diff && <DiffBlock diff={part.diff} />}
        </div>
      </details>
    </div>
  );
}

function MessageParts({ parts, labels, onOpenToolFile, live }: { parts: MessagePart[]; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile']; /** 组处于流式且这是最后一个 part：思考行滚动展示内容 */ live?: boolean }) {
  return (
    <>
      {parts.map((p) => {
        switch (p.kind) {
          case 'image':
            return <img key={p.id} className="pi-message-image" src={`data:${p.mimeType};base64,${p.data}`} alt="附件图片" />;
          case 'text':
            return <ChatMarkdown key={p.id} text={p.text} />;
          case 'thinking':
            return <ExecutionNote key={p.id} title={`${labels.you === '你' ? '思考' : 'Thought'}${p.durationMs !== undefined ? ` · ${labels.you === '你' ? `用时 ${Math.max(1, Math.ceil(p.durationMs / 1000))} 秒` : `took ${Math.max(1, Math.ceil(p.durationMs / 1000))}s`}` : ''}`} text={p.text} active={live} />;
          case 'tool':
            return <ToolCard key={p.id} part={p} labels={labels} onOpenToolFile={onOpenToolFile} />;
          case 'notice':
            return (
              <div key={p.id} className="pi-notice">
                {p.text}
              </div>
            );
          case 'error':
            return (
              <div key={p.id} className="pi-error">
                {p.message}
              </div>
            );
        }
      })}
    </>
  );
}

/** 已发送的图片附件：点击放大（灯箱，Esc/点背景关闭），灯箱工具条可下载原图。 */
function MessageImage({ part, labels, onDownload }: { part: Extract<MessagePart, { kind: 'image' }>; labels: ChatViewProps['labels']; onDownload?: ChatViewProps['onDownloadImage'] }) {
  const [open, setOpen] = useState(false);
  const dataUrl = `data:${part.mimeType};base64,${part.data}`;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const ext = part.mimeType === 'image/jpeg' ? 'jpg' : part.mimeType.slice('image/'.length);
  const name = `pi-image-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${ext}`;
  return <>
    <button type="button" className="pi-msg__imagebtn" title={labels.viewImage} aria-label={labels.viewImage} onClick={() => setOpen(true)}>
      <img className="pi-msg__image" src={dataUrl} alt="附件图片" />
    </button>
    {open && createPortal(
      <div className="pi-lightbox" role="dialog" aria-modal="true" aria-label={labels.viewImage} onClick={() => setOpen(false)}>
        <div className="pi-lightbox__bar">
          {onDownload && <button type="button" className="pi-lightbox__btn" title={labels.downloadImage} aria-label={labels.downloadImage} onClick={e => { e.stopPropagation(); onDownload(dataUrl, name); }}><Icon name="download-cloud" size={15} /></button>}
          <button type="button" className="pi-lightbox__btn" title={labels.close} aria-label={labels.close} onClick={() => setOpen(false)}><Icon name="x" size={15} /></button>
        </div>
        <img className="pi-lightbox__img" src={dataUrl} alt="附件图片" onClick={e => e.stopPropagation()} />
      </div>,
      document.body,
    )}
  </>;
}

/** 用户消息结构（参考 ZCode）：图片先独立展示在上，文字再进气泡放在下方。 */
function UserMessageParts({ parts, labels, onOpenToolFile, onDownloadImage }: { parts: MessagePart[]; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile']; onDownloadImage?: ChatViewProps['onDownloadImage'] }) {
  const images = parts.filter((p): p is Extract<MessagePart, { kind: 'image' }> => p.kind === 'image');
  const rest = parts.filter(p => p.kind !== 'image');
  return (
    <>
      {images.map(p => <MessageImage key={p.id} part={p} labels={labels} onDownload={onDownloadImage} />)}
      {rest.length > 0 && <div className="pi-msg__bubble"><MessageParts parts={rest} labels={labels} onOpenToolFile={onOpenToolFile} /></div>}
    </>
  );
}

function ExecutionNote({ title, text, active }: { title: string; text: string; /** 这条思考正在流式输出：行内滚动展示内容尾部，完成后恢复计时标题 */ active?: boolean }) {
  // 受控开合：流式渲染每 ~150ms 重渲染，非受控 details 的 open 会被 React 重置，
  // 用户点开后立即被关上 → 看不到正文。用 state 跟随 toggle。
  const [open, setOpen] = useState(false);
  // 流式中的滚动带：剥掉 markdown 装饰后取尾部（新内容从右持续推入，旧行被推走）。
  const tail = active
    ? text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`([^`]+?)`/g, '$1').replace(/\s+/g, ' ').trim().slice(-160)
    : '';
  return <details className="pi-execution__note" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary><Icon name="brain" size={17}/>
      {active
        ? <><strong className="pi-execution__thinking">正在思考</strong><span className="pi-execution__ticker"><span className="pi-execution__ticker-inner">{tail}</span></span></>
        : <span>{title}</span>}
      <Icon name="chevron-right" size={12} className="pi-execution__chevron" /></summary>
    <div className="pi-execution__note-body"><ChatMarkdown text={text} /></div>
  </details>;
}

export function ElapsedTime({ startedAt, endedAt, running, zh }: { startedAt?: number; endedAt?: number; running: boolean; zh: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  if (startedAt === undefined || (!running && endedAt === undefined)) return null;
  return <span className="pi-execution__elapsed">{running ? (zh ? '已工作 ' : 'Working for ') : (zh ? '用时 ' : 'Took ')}{formatElapsed((running ? now : endedAt!) - startedAt, zh)}</span>;
}

export function ExecutionGroup({ turn, parts, running, active, expanded, showElapsed, labels, onOpenToolFile }: { turn: ChatTurn; parts: MessagePart[]; running: boolean; /** 仅最后一个 steps 段为 active：转圈/计时/正在思考只出现一处 */ active?: boolean; /** 回合进行中：所有过程段都保持展开（用户要求），完成态不传即默认折叠 */ expanded?: boolean; showElapsed?: boolean; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile'] }) {
  const zh = labels.you === '你';
  const live = active ?? running;
  const [userOpen, setUserOpen] = useState(false);
  // 回合进行中强制展开（expanded 覆盖所有段，不限最后一个）；完成态跟随用户手动开合。
  // 非受控会被流式 re-render 重置，open 必须是受控推导。
  const open = running || expanded || userOpen;
  const hasTiming = showElapsed && turn.startedAt !== undefined && (live || turn.endedAt !== undefined);
  const failures = parts.filter(p => p.kind === 'error' || (p.kind === 'tool' && p.status === 'error')).length;
  // 模型此刻正在流式输出思考（最新内容是 thinking）→ 该思考行内滚动展示内容（见 ExecutionNote active）。
  // running 的组必须保持展开：工具组后面跟着文字段时，用户仍要能看到正在执行/刚执行的步骤
  return <details open={open} onToggle={(e) => !running && setUserOpen(e.currentTarget.open)} className={`pi-execution ${running ? 'pi-execution--running' : ''} ${failures ? 'pi-execution--error' : ''}`}>
    <summary className="pi-execution__summary">
      {/* 「正在思考」粗体由活动思考行自己展示（滚动内容同行）；组头只保留计时，避免重复 */}
      {hasTiming ? <ElapsedTime startedAt={turn.startedAt} endedAt={turn.endedAt} running={live} zh={zh} /> : <span className="pi-execution__title">{live ? (zh ? '正在工作' : 'Working') : (zh ? `执行过程 · ${parts.length} 步` : `Execution · ${parts.length} steps`)}</span>}
      {failures > 0 && <span className="pi-execution__failure">{failures} {zh ? '项失败' : 'failed'}</span>}
      {live && <Spinner label={zh ? '运行中' : 'Running'} />}
      <Icon name="chevron-right" size={14} className="pi-execution__chevron" />
    </summary>
    <div className="pi-execution__steps">{parts.map((p, i) => p.kind === 'text'
      ? <div key={p.id} className="pi-execution__commentary"><ChatMarkdown text={p.text} /></div>
      : <MessageParts key={p.id} parts={[p]} labels={labels} onOpenToolFile={onOpenToolFile} live={live && i === parts.length - 1} />)}</div>
  </details>;
}

function firstText(parts: MessagePart[]): string {
  const hit = parts.find((p): p is Extract<MessagePart, { kind: 'text' }> => p.kind === 'text' && p.text.trim().length > 0);
  // 先截断再压缩空白：rail 每次流式刷新都会扫全部轮次，对整段文本跑正则是白烧 CPU。
  return hit ? hit.text.trim().slice(0, 64).replace(/\s+/g, ' ').trim() : '';
}

function lastText(parts: MessagePart[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === 'text' && p.text.trim().length > 0) return p.text.trim().slice(-64).replace(/\s+/g, ' ').trim();
  }
  return '';
}

export interface RailEntry { id: string; role: 'user' | 'assistant'; question: string; summary: string; steps: number }

/** ZCode-style "chrysanthemum" activity indicator: 8 radiating petals, ticking. */
export function Spinner(props: { label?: string }) {
  return (
    <span className="pi-spinner" role={props.label ? 'status' : undefined} aria-label={props.label}>
      {Array.from({ length: 8 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 45}deg)` }} />)}
    </span>
  );
}

/** One rail tick per Q+A pair: the user prompt plus the execution it triggered.
 * The hover summary is the turn's CONCLUSION (last text part) — prompts like
 * repeated「继续」must still get distinct tips via what the work actually did. */
export function railEntries(turns: ChatTurn[]): RailEntry[] {
  const entries: RailEntry[] = [];
  const toolCount = (turn: ChatTurn | undefined) => turn?.steps.filter((p) => p.kind === 'tool').length ?? 0;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'user') {
      const next = turns[i + 1];
      const exec = next?.role === 'assistant' ? next : undefined;
      if (exec) i++;
      const question = firstText(turn.answer).slice(0, 48) || '用户消息';
      const summary = (exec ? lastText(exec.answer).slice(0, 60) : '')
        || (toolCount(exec) ? `${toolCount(exec)} 步工具调用` : '')
        || (exec ? '执行过程' : '');
      entries.push({ id: turn.id, role: 'user', question, summary, steps: toolCount(exec) });
      continue;
    }
    const conclusion = lastText(turn.answer).slice(0, 60);
    entries.push({
      id: turn.id,
      role: 'assistant',
      question: '',
      summary: conclusion || (toolCount(turn) ? `${toolCount(turn)} 步工具调用` : '执行过程'),
      steps: toolCount(turn),
    });
  }
  return entries;
}

/** Left message-navigation rail (the reference "minimap"): one mark per
 * user/assistant turn, evenly distributed, hover shows a summary, and the
 * mark of the turn currently in view stays highlighted. */
export function MessageNav({ turns, listRef, onJump }: { turns: ChatTurn[]; listRef: React.RefObject<HTMLDivElement | null>; onJump: (id: string) => void }) {
  const entries = useMemo(() => railEntries(turns), [turns]);
  const [active, setActive] = useState(-1);
  const [tip, setTip] = useState<{ index: number; top: number } | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !entries.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = list.getBoundingClientRect().top + 80;
      let index = 0;
      for (let i = 0; i < entries.length; i++) {
        const el = list.querySelector(`[data-msg="${CSS.escape(entries[i].id)}"]`);
        if (el && el.getBoundingClientRect().top <= line) index = i;
      }
      setActive((prev) => (prev === index ? prev : index));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    list.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => { list.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [entries, listRef]);
  if (entries.length < 3) return null;
  return (
    <nav className="pi-rail" aria-label="Message navigation">
      <div className="pi-rail__inner">
        {entries.map((e, i) => (
          <div key={e.id} className="pi-rail__slot">
            <button
              className={`pi-rail__mark pi-rail__mark--${e.role} ${i === active ? 'pi-rail__mark--active' : ''}`}
              onMouseEnter={(ev) => {
                const slot = (ev.currentTarget as HTMLElement).parentElement;
                setTip({ index: i, top: slot ? slot.offsetTop + slot.offsetHeight / 2 : 0 });
              }}
              onMouseLeave={() => setTip(null)}
              onFocus={(ev) => {
                const slot = (ev.currentTarget as HTMLElement).parentElement;
                setTip({ index: i, top: slot ? slot.offsetTop + slot.offsetHeight / 2 : 0 });
              }}
              onBlur={() => setTip(null)}
              onClick={() => onJump(e.id)}
              aria-label={e.summary ? `${e.question || '助手'}：${e.summary}` : e.question}
            />
          </div>
        ))}
      </div>
      {tip && entries[tip.index] && (() => {
        const e = entries[tip.index];
        return (
          <span className="pi-rail__tip" role="tooltip" style={{ top: tip.top }}>
            {e.question && <b>{e.question}</b>}
            {(e.summary || !e.question) && <em>{e.summary || '执行过程'}</em>}
          </span>
        );
      })()}
    </nav>
  );
}

// Memoized: streaming store updates re-render the app root many times per
// second; the (potentially huge) markdown list must not re-render unless its
// own props changed.
/** 单轮消息：memo 化 + turn/消息身份稳定（adapter 缓存 + executionTurns 缓存），
 *  千条级会话流式时每次事件只重渲染活动轮，而不是全量 600+ 行。 */
export const TurnArticle = memo(function TurnArticle({ m, liveTurn, labels, onOpenToolFile, onEditUser, onDownloadImage }: { m: ChatTurn; liveTurn: boolean; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile']; /** 提供时用户消息可「编辑并重发」（先 fork 截断再发送，等价 ZCode 编辑语义）。 */ onEditUser?: (entryId: string, text: string) => void; onDownloadImage?: ChatViewProps['onDownloadImage'] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const userText = m.role === 'user' ? m.answer.filter(p => p.kind === 'text').map(p => (p as Extract<MessagePart, { kind: 'text' }>).text).join('\n\n') : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(userText);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch { /* 剪贴板权限被拒时静默——气泡已有完整文本可手动选择 */ }
  };
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    onEditUser?.(m.id, text);
  };
  return (
    <article data-msg={m.id} className={`pi-msg pi-msg--${m.role}`}>
      {m.simulated && (
        <div className="pi-msg__simtag">
          <Icon name="sparkle" size={12} /> {labels.simulatedRun}
          {m.model ? ` · ${m.model}` : ''}
        </div>
      )}
      {m.role === 'user'
        ? <>
          {editing
            ? <div className="pi-msg__editbox">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') setEditing(false);
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
                }}
                rows={Math.min(12, Math.max(2, draft.split('\n').length + 1))}
                autoFocus
              />
              <div className="pi-msg__editbtns">
                <button className="pi-btn pi-btn--primary" onClick={submit} disabled={!draft.trim()}>{labels.resend}</button>
                <button className="pi-btn pi-btn--ghost" onClick={() => setEditing(false)}>{labels.cancel}</button>
              </div>
            </div>
            : <UserMessageParts parts={m.answer} labels={labels} onOpenToolFile={onOpenToolFile} onDownloadImage={onDownloadImage} />}
          {!editing && (userText || onEditUser) && (
            <div className="pi-msg__actions">
              {userText && <button type="button" className="pi-msg__action" title={copied ? labels.copied : labels.copyMessage} aria-label={labels.copyMessage} onClick={() => void copy()}>{copied ? <><Icon name="check" size={13} /><span>{labels.copied}</span></> : <Icon name="copy" size={13} />}</button>}
              {onEditUser && userText && <button type="button" className="pi-msg__action" title={labels.editMessage} aria-label={labels.editMessage} onClick={() => { setDraft(userText); setEditing(true); }}><Icon name="pencil" size={13} /></button>}
            </div>
          )}
        </>
        : (() => {
          if (liveTurn) {
            // 活动轮：保持时间顺序，逐步段渲染；所有过程段保持展开（用户要求：
            // 工作进行中进度可见，中途出现结论文字也不折叠，完成态才统一收起）
            return <>{m.segments.map((seg, si) => {
              const liveSegment = si === m.segments.length - 1;
              if (seg.kind === 'steps' && seg.parts.length > 0) {
                return <ExecutionGroup key={`${m.id}-seg-${si}`} turn={m} parts={seg.parts} running={liveSegment} active={liveSegment} expanded showElapsed={liveSegment} labels={labels} onOpenToolFile={onOpenToolFile} />;
              }
              if (seg.kind === 'text' && seg.parts.length > 0) {
                return <div key={`${m.id}-seg-${si}`} className="pi-msg__answer"><MessageParts parts={seg.parts} labels={labels} onOpenToolFile={onOpenToolFile} /></div>;
              }
              return null;
            })}</>;
          }
          // 完成态：思考与工具都是任务过程产物，统一收进「用时」折叠块，结论直接可见
          const allSteps = m.segments.filter((s) => s.kind === 'steps').flatMap((s) => s.parts);
          const allText = m.segments.filter((s) => s.kind === 'text').flatMap((s) => s.parts);
          const zh = labels.you === '你';
          return <>
            {allSteps.length > 0
              ? <ExecutionGroup turn={m} parts={allSteps} running={false} showElapsed labels={labels} onOpenToolFile={onOpenToolFile} />
              : <div className="pi-chat__elapsed"><ElapsedTime startedAt={m.startedAt} endedAt={m.endedAt} running={false} zh={zh} /></div>}
            {allText.length > 0 && <div className="pi-msg__answer"><MessageParts parts={allText} labels={labels} onOpenToolFile={onOpenToolFile} /></div>}
          </>;
        })()}
    </article>
  );
});

export const ChatView = memo(function ChatView(props: ChatViewProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // 用户滚离底部时显示「跳到最新/当前任务」浮动按钮。
  const [showJump, setShowJump] = useState(false);
  // 跟随状态对外暴露：跳转按钮可恢复自动跟随
  const followingRef = useRef(true);
  // Follow streamed activity while the reader stays near the bottom.
  // Scrolling up pauses following so earlier messages remain readable.
  useEffect(() => {
    const list = listRef.current;
    const content = list?.firstElementChild;
    if (!list || !content) return;
    let following = true;
    let userScrollUntil = 0;
    let frame = 0;
    const markUserScroll = () => { userScrollUntil = performance.now() + 1000; };
    const onWheel = (event: WheelEvent) => {
      markUserScroll();
      if (event.deltaY < 0) { following = false; followingRef.current = false; }
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) markUserScroll();
    };
    const onPointer = (event: PointerEvent) => {
      // Scrollbar dragging, not opening a disclosure, is a scrolling gesture.
      if (event.target === list) markUserScroll();
    };
    const onScroll = () => {
      // Expansion and stream growth can trigger scroll anchoring. They must not
      // be mistaken for a reader deliberately leaving the bottom.
      if (performance.now() < userScrollUntil) {
        following = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        followingRef.current = following;
      }
      // 离开底部 → 显示跳转按钮；回到底部 → 隐藏
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      setShowJump((prev) => (prev === !nearBottom ? prev : !nearBottom));
    };
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (following) list.scrollTop = list.scrollHeight; });
    };
    const onToggle = () => { userScrollUntil = 0; follow(); };
    const observer = new ResizeObserver(follow);
    list.addEventListener('scroll', onScroll, { passive: true });
    list.addEventListener('wheel', onWheel, { passive: true });
    list.addEventListener('touchmove', markUserScroll, { passive: true });
    list.addEventListener('pointerdown', onPointer);
    list.addEventListener('keydown', onKey);
    list.addEventListener('toggle', onToggle, true);
    observer.observe(content);
    follow();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      list.removeEventListener('scroll', onScroll);
      list.removeEventListener('wheel', onWheel);
      list.removeEventListener('touchmove', markUserScroll);
      list.removeEventListener('pointerdown', onPointer);
      list.removeEventListener('keydown', onKey);
      list.removeEventListener('toggle', onToggle, true);
    };
  }, []);

  const turns = useMemo(() => {
    const result = executionTurns(props.messages);
    const last = result[result.length - 1];
    const timing = props.runTiming;
    if (last?.role === 'assistant' && timing && ((last.endedAt ?? 0) >= timing.startedAt || (last.startedAt ?? 0) >= timing.startedAt - 1000)) {
      last.startedAt = timing.startedAt;
      last.endedAt = timing.endedAt;
    }
    return result;
  }, [props.messages, props.runTiming]);
  // 历史落地交换（agent_settled → refreshHistory → 消息数组整体重建）后，贴底滚动走
  // ResizeObserver+rAF，在 paint 之后才执行，中间那一帧会闪现较早的消息。这里在提交
  // 前同步贴底（仅在已处于跟随状态时），消除刷屏感。
  const lastTurnKey = turns.length ? `${turns[turns.length - 1]!.id}:${turns[turns.length - 1]!.steps.length}` : '';
  useLayoutEffect(() => {
    if (followingRef.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [lastTurnKey]);
  const jump = (id: string) => {
    const target = turns.find(t => t.messageIds.includes(id))?.id || id;
    const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-msg]') || []).find(e => e.dataset.msg === target);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    props.onJumpToMessage(id);
  };
  const jumpToBottom = () => {
    const list = listRef.current;
    if (!list) return;
    followingRef.current = true;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    setShowJump(false);
  };

  // 长会话只渲染尾部窗口：全量 2000+ 轮一次性上 DOM 是打开大会话秒级长帧的主因
  // （布局/绘制成本也随总节点数走，流式期间每次 flush 都在付）。顶部滚动到近处
  // 自动补载更早消息（并保留视口锚点），顶部常驻一条「更早消息」提示可手动点。
  const TAIL_WINDOW = 60;
  const LOAD_STEP = 60;
  const [renderLimit, setRenderLimit] = useState(TAIL_WINDOW);
  const limitEpochRef = useRef('');
  const firstTurnId = turns[0]?.id ?? '';
  useEffect(() => {
    // 切会话（首条 turn 变化）时重置窗口；同会话内 turns 增长不重置。
    if (limitEpochRef.current !== firstTurnId) {
      limitEpochRef.current = firstTurnId;
      setRenderLimit(TAIL_WINDOW);
    }
  }, [firstTurnId]);
  const hiddenCount = Math.max(0, turns.length - renderLimit);
  const visibleTurns = hiddenCount > 0 ? turns.slice(turns.length - renderLimit) : turns;
  const prependAnchorRef = useRef<{ height: number } | null>(null);
  const loadEarlier = useCallback(() => {
    const list = listRef.current;
    if (list) prependAnchorRef.current = { height: list.scrollHeight };
    setRenderLimit((limit) => Math.min(turns.length, limit + LOAD_STEP));
  }, [turns.length]);
  useLayoutEffect(() => {
    // 补载在头部插入节点：把新增高度补进 scrollTop，视口锚定在原来那条消息上。
    const anchor = prependAnchorRef.current;
    const list = listRef.current;
    if (!anchor || !list) return;
    prependAnchorRef.current = null;
    if (list.scrollHeight > anchor.height) list.scrollTop += list.scrollHeight - anchor.height;
  });
  useEffect(() => {
    const list = listRef.current;
    if (!list || hiddenCount === 0) return;
    const onScroll = () => {
      if (list.scrollTop < 240) loadEarlier();
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => list.removeEventListener('scroll', onScroll);
  }, [hiddenCount, loadEarlier]);

  return (
    <div className="pi-chat">
      <MessageNav turns={turns} listRef={listRef} onJump={jump} />
      <div className="pi-chat__scroll" ref={listRef}>
        <div className="pi-chat__inner">
          {hiddenCount > 0 && (
            <button type="button" className="pi-chat__earlier" onClick={loadEarlier}>
              {props.labels.you === '你' ? `更早的消息 · 还有 ${hiddenCount} 轮` : `Earlier messages · ${hiddenCount} more`}
            </button>
          )}
          {visibleTurns.map((m) => (
            <TurnArticle key={m.id} m={m} liveTurn={props.running && m === turns[turns.length - 1]} labels={props.labels} onOpenToolFile={props.onOpenToolFile} onEditUser={props.onEditUserMessage} onDownloadImage={props.onDownloadImage} />
          ))}
          {props.sending && props.sendingText && (
            <article className="pi-msg pi-msg--user pi-msg--pending">
              <UserMessageParts parts={[{ kind: 'text', id: 'pi-pending-prompt', text: props.sendingText }]} labels={props.labels} onOpenToolFile={props.onOpenToolFile} />
            </article>
          )}
          {(() => {
            // 发送后立刻转圈计时；一旦执行组（steps）开始流式输出，计时交还给组内，避免重复。
            const lastTurn = turns[turns.length - 1];
            const stepsLive = (lastTurn?.segments.at(-1)?.kind ?? 'text') === 'steps';
            if (!props.sending && !props.running) return null;
            const timerStart = props.runTiming?.startedAt ?? props.sendingAt;
            const zh = props.labels.you === '你';
            return (
              <div className="pi-chat__working" role="status" aria-label={props.labels.working}>
                <Spinner />
                {props.queued > 0 && <span>{props.queued} {props.labels.queued}</span>}
                {!stepsLive && timerStart !== undefined && <ElapsedTime startedAt={timerStart} running zh={zh} />}
                <span className="pi-chat__caret" />
              </div>
            );
          })()}
        </div>
      </div>
      {showJump && (
        <button className="pi-chat__jumpbottom" onClick={jumpToBottom} aria-label={props.labels.you === '你' ? '回到最新' : 'Jump to latest'} title={props.labels.you === '你' ? '回到最新 / 当前任务' : 'Jump to latest'}>
          <Icon name="chevron-down" size={18} />
        </button>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

type OpenMenu = 'model' | 'reasoning' | 'agent' | 'permission' | 'popup' | null;

/** The context suffix the desktop appends to prompts; rows display/edit only the head. */
const QUEUE_CONTEXT_MARK = '\n\n用户选择的上下文';

function QueueRow({ item, labels, onNow, onRecall, onRemove }: {
  item: { text: string; behavior: 'steer' | 'followUp'; images?: PiImage[] };
  labels: ComposerProps['labels'];
  onNow?: () => void;
  onRecall?: () => void;
  onRemove?: () => void;
}) {
  const cut = item.text.indexOf(QUEUE_CONTEXT_MARK);
  const head = cut >= 0 ? item.text.slice(0, cut) : item.text;
  return (
    <div className="pi-prompt-queue__row" role="listitem">
      <Icon name="grip" size={13} />
      {item.images && item.images.length > 0 && (
        <div className="pi-prompt-queue__thumbs">
          {item.images.map((img, i) => (
            <img key={i} className="pi-prompt-queue__thumb" src={`data:${img.mimeType};base64,${img.data}`} alt={`附件 ${i + 1}`} />
          ))}
        </div>
      )}
      <span className="pi-prompt-queue__text" title={head}>{head}</span>
      {item.behavior === 'steer' && <span className="pi-prompt-queue__tag">steer</span>}
      {onNow && (
        <button className="pi-prompt-queue__now" onClick={onNow} title={labels.queueNow}>
          <Icon name="arrow-up" size={12} />
          {labels.queueNow ?? '立即'}
        </button>
      )}
      {onRecall && (
        <button className="pi-iconbtn pi-prompt-queue__btn" aria-label={labels.queueEdit ?? '编辑'} title={labels.queueEdit ?? '编辑（载入输入框，可改图片）'} onClick={onRecall}>
          <Icon name="pencil" size={13} />
        </button>
      )}
      {onRemove && (
        <button className="pi-iconbtn pi-prompt-queue__btn" aria-label={labels.queueRemove ?? 'Remove'} title={labels.queueRemove} onClick={onRemove}>
          <Icon name="trash" size={13} />
        </button>
      )}
    </div>
  );
}

export function Composer(props: ComposerProps) {
  // 本地优先：按键只更新本地状态，store 镜像防抖 200ms（对齐 ZCode：键入不碰全局状态，
  // 否则每键触发整棵应用树重渲染造成输入卡顿）；发送/卸载时立即冲刷，外部注入同步回本地。
  const [localText, setLocalText] = useState(props.draftText ?? '');
  const text = localText;
  const draftRef = useRef(props.draftText ?? '');
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDraft = () => {
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    if (props.onDraftChange && draftRef.current !== props.draftText) props.onDraftChange(draftRef.current);
  };
  useEffect(() => () => flushDraft(), []);
  useEffect(() => { if (props.draftText !== undefined) setLocalText(props.draftText); }, [props.draftText]);
  const setText = (value: React.SetStateAction<string>) => {
    const next = typeof value === 'function' ? value(text) : value;
    setLocalText(next);
    draftRef.current = next;
    if (props.onDraftChange) {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => { draftTimer.current = null; props.onDraftChange?.(draftRef.current); }, 200);
    }
  };
  const [menu, setMenu] = useState<OpenMenu>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popup = parseMenuState(text);
  // The files prop seeds the mention list; window.pi enrichment (when present)
  // can extend it, but the prop alone must work (production passes []).
  const [scannedFiles, setScannedFiles] = useState<string[] | null>(null);
  const files = scannedFiles ?? props.files;
  const commands = popup.kind === 'slash' ? filterCommands(props.slashCommands, popup.query) : [];
  const fileHits = popup.kind === 'file' ? filterFiles(files, popup.query) : [];
  const popupIndex = useRef(0);
  popupIndex.current = 0;

  // Close button menus on any outside click.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const submit = () => {
    flushDraft();
    const value = text.trim();
    if ((!value && !props.hasAttachments) || props.preparing) return;
    setText('');
    props.onSend(value);
    setMenu(null);
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const popupOpen = popup.kind !== null && (popup.kind === 'slash' ? commands.length > 0 : fileHits.length > 0);
    if (popupOpen) {
      const count = popup.kind === 'slash' ? commands.length : fileHits.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        popupIndex.current = (popupIndex.current + 1) % count;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        popupIndex.current = (popupIndex.current - 1 + count) % count;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const choice = popup.kind === 'slash' ? commands[popupIndex.current].name : fileHits[popupIndex.current];
        setText((t) => applyMenuSelection(t, choice));
        return;
      }
      if (e.key === 'Escape') {
        setText((t) => t.replace(/(^|\s)([/@])\S*$/, '$1'));
        return;
      }
    } else if (e.key === 'Escape' && menu) {
      setMenu(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  };

  const modeLabel =
    props.agentMode === 'plan' ? props.labels.modePlan : props.agentMode === 'goal' ? props.labels.modeGoal : props.labels.modeAgent;
  const permLabel =
    props.permissionMode === 'autoedit'
      ? props.labels.permissionAutoedit
      : props.permissionMode === 'full'
        ? props.labels.permissionFull
        : props.labels.permissionAsk;
  const activeModel = props.modelGroups.flatMap((g) => g.models).find((m) => m.id === props.modelId);
  const pendingModel = props.pendingModelId ? props.modelGroups.flatMap((g) => g.models).find((m) => m.id === props.pendingModelId) : undefined;

  return (
    <div className="pi-composer-wrap" ref={wrapRef}>
      {props.headerSlot}
      {/* slash / file popup */}
      {popup.kind === 'slash' && commands.length > 0 && (
        <div className="pi-composer__popup" role="listbox" aria-label={props.labels.slashCommands}>
          {commands.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === popupIndex.current}
              className={`pi-composer__opt ${i === popupIndex.current ? 'pi-composer__opt--sel' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setText((t) => applyMenuSelection(t, c.name));
              }}
            >
              <span className="pi-composer__optname">{c.name}</span>
              <span className="pi-composer__optdesc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {popup.kind === 'file' && fileHits.length > 0 && (
        <div className="pi-composer__popup" role="listbox" aria-label={props.labels.atFiles}>
          {fileHits.map((f, i) => (
            <button
              key={f}
              role="option"
              aria-selected={i === popupIndex.current}
              className={`pi-composer__opt pi-composer__opt--file ${i === popupIndex.current ? 'pi-composer__opt--sel' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setText((t) => applyMenuSelection(t, `@${f}`));
              }}
            >
              <Icon name="file" size={13} />
              <span className="pi-composer__optname">{f}</span>
            </button>
          ))}
        </div>
      )}

      {/* model / reasoning popover */}
      {(menu === 'model' || menu === 'reasoning') && (
        <div className="pi-composer__menu" role="menu">
          <button
            className="pi-composer__menurow"
            role="menuitem"
            onClick={() => setMenu('model')}
            aria-expanded={menu === 'model'}
          >
            <Icon name="bot" size={15} />
            <span>{props.labels.model}</span>
            <span className="pi-composer__menuvalue">
              {menu === 'model' ? (activeModel?.name ?? props.labels.model) : props.labels.model}
              <Icon name="chevron-right" size={13} />
            </span>
          </button>
          {menu === 'model' && (
            <>
              {props.modelGroups.map((g: ModelGroup) => (
                <div key={g.provider}>
                  <div className="pi-composer__menugroup">{g.provider}</div>
                  {g.models.map((m) => (
                    <button
                      key={m.id}
                      className={`pi-composer__menurow pi-composer__menurow--sub ${m.id === props.modelId ? 'pi-composer__menurow--on' : ''}`}
                      role="menuitemradio"
                      aria-checked={m.id === props.modelId}
                      onClick={() => {
                        props.onPickModel(m.id);
                        setMenu(null);
                      }}
                    >
                      <span>{m.name}</span>
                      <span className="pi-composer__menuvalue">{m.detail}</span>
                      {m.id === props.modelId && <Icon name="check" size={13} />}
                    </button>
                  ))}
                </div>
              ))}
              {!props.hideReasoning && (
                <button
                  className="pi-composer__menurow"
                  role="menuitem"
                  onClick={() => setMenu('reasoning')}
                  aria-expanded={false}
                >
                  <Icon name="sparkle" size={15} />
                  <span>{props.labels.reasoning}</span>
                  <span className="pi-composer__menuvalue">
                    {props.reasoning === 'off' ? props.labels.reasoningOff : props.labels[`reasoning${props.reasoning[0].toUpperCase()}${props.reasoning.slice(1)}` as 'reasoningLow']}
                    <Icon name="chevron-right" size={13} />
                  </span>
                </button>
              )}
            </>
          )}
          {menu === 'reasoning' && (
            <>
              {(['off', 'low', 'medium', 'high'] as const).map((lv) => (
                <button
                  key={lv}
                  className={`pi-composer__menurow pi-composer__menurow--sub ${lv === props.reasoning ? 'pi-composer__menurow--on' : ''}`}
                  role="menuitemradio"
                  aria-checked={lv === props.reasoning}
                  onClick={() => {
                    props.onPickReasoning(lv);
                    setMenu(null);
                  }}
                >
                  <span>{props.labels[`reasoning${lv[0].toUpperCase()}${lv.slice(1)}` as 'reasoningLow']}</span>
                  {lv === props.reasoning && <Icon name="check" size={13} />}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* agent / permission menu */}
      {(menu === 'agent' || menu === 'permission') && (
        <div className="pi-composer__menu pi-composer__menu--left" role="menu">
          {menu === 'agent'
            ? (['agent', 'plan', 'goal'] as const).map((m) => (
                <button
                  key={m}
                  role="menuitemradio"
                  aria-checked={m === props.agentMode}
                  className={`pi-composer__menurow ${m === props.agentMode ? 'pi-composer__menurow--on' : ''}`}
                  onClick={() => {
                    props.onPickAgentMode(m);
                    setMenu(null);
                  }}
                >
                  <Icon name="shield" size={14} />
                  <span>{m === 'plan' ? props.labels.modePlan : m === 'goal' ? props.labels.modeGoal : props.labels.modeAgent}</span>
                </button>
              ))
            : (['ask', 'autoedit', 'full'] as const).map((m) => (
                <button
                  key={m}
                  role="menuitemradio"
                  aria-checked={m === props.permissionMode}
                  className={`pi-composer__menurow ${m === props.permissionMode ? 'pi-composer__menurow--on' : ''}`}
                  onClick={() => {
                    props.onPickPermission(m);
                    setMenu(null);
                  }}
                >
                  <span>
                    {m === 'ask' ? props.labels.permissionAsk : m === 'autoedit' ? props.labels.permissionAutoedit : props.labels.permissionFull}
                  </span>
                </button>
              ))}
          {props.demo && <div className="pi-composer__menunote">{props.labels.demoBadge}</div>}
        </div>
      )}

      {!!props.queue?.length && (
        <div className="pi-prompt-queue" role="list">
          {props.queue.map((item, index) => (
            <QueueRow
              key={`${index}-${item.text.length}`}
              item={item}
              labels={props.labels}
              onNow={props.onQueueNow ? () => props.onQueueNow!(index) : undefined}
              onRecall={props.onQueueRecall ? () => props.onQueueRecall!(index) : undefined}
              onRemove={props.onQueueRemove ? () => props.onQueueRemove!(index) : undefined}
            />
          ))}
        </div>
      )}
      <div className={`pi-composer ${props.running ? 'pi-composer--running' : ''}`}>
        {props.contextSlot}
        <textarea
          ref={taRef}
          className="pi-composer__input"
          rows={1}
          value={text}
          placeholder={props.sessionActive ? props.labels.placeholderSession : props.labels.placeholderHome}
          aria-label={props.labels.send}
          onChange={(e) => {
            setText(e.target.value);
            autoResize(e.target);
          }}
          onPaste={props.onPaste}
          onKeyDown={onKeyDown}
          onBlur={() => {
            /* menus close via document click; keep caret UX simple */
          }}
        />
        <div className="pi-composer__toolbar">
          <div className="pi-composer__left">
            {props.addSlot ?? <button className="pi-iconbtn" aria-label={props.labels.attachDisabled} title={props.labels.attachDisabled} disabled>
              <Icon name="plus" />
            </button>}
            {props.leftSlot ?? (
              <>
                <button
                  className="pi-composer__pill"
                  onClick={() => setMenu(menu === 'agent' ? null : 'agent')}
                  aria-expanded={menu === 'agent'}
                >
                  <Icon name="shield" size={14} />
                  <span>{modeLabel}</span>
                </button>
                <button
                  className={`pi-composer__pill ${props.permissionMode === 'full' ? 'pi-composer__pill--warn' : ''}`}
                  onClick={() => setMenu(menu === 'permission' ? null : 'permission')}
                  aria-expanded={menu === 'permission'}
                >
                  <Icon name="warning" size={14} />
                  <span>{permLabel}</span>
                  <Icon name="chevron-down" size={13} />
                </button>
              </>
            )}
          </div>
          <div className="pi-composer__right">
            {props.statusSlot}
            <button
              disabled={props.modelDisabled}
              className={`pi-composer__pill ${menu === 'model' ? 'pi-composer__pill--on' : ''}`}
              onClick={() => setMenu(menu === 'model' ? null : 'model')}
              aria-expanded={menu === 'model'}
              title={pendingModel ? (props.labels.pendingSwitch ? `${props.labels.pendingSwitch}：${pendingModel.name}` : pendingModel.name) : undefined}
            >
              <Icon name="bot" size={14} />
              <span>{pendingModel ? pendingModel.name : activeModel?.name ?? props.labels.model}</span>
              {pendingModel && <span className="pi-composer__pending">{props.labels.pendingSwitch ?? '待生效'}</span>}
              <Icon name="chevron-down" size={13} />
            </button>
            {!props.hideReasoning && (
              <button
                className={`pi-composer__pill ${menu === 'reasoning' ? 'pi-composer__pill--on' : ''}`}
                onClick={() => setMenu(menu === 'reasoning' ? null : 'reasoning')}
                aria-expanded={menu === 'reasoning'}
              >
                <Icon name="brain" size={14} />
                <span>
                  {props.reasoning === 'off'
                    ? props.labels.reasoningOff
                    : props.labels[`reasoning${props.reasoning[0].toUpperCase()}${props.reasoning.slice(1)}` as 'reasoningLow']}
                </span>
                <Icon name="chevron-down" size={13} />
              </button>
            )}
            {props.reasoningSlot}
            {/* One morphing action button, like the reference: while a task
                runs it is Stop; typing a follow-up turns it into Send
                (queued), clearing text returns it to Stop. */}
            {props.running && !text.trim() && !props.hasAttachments ? (
              <button className="pi-composer__send pi-composer__send--stop" onClick={props.onStop} aria-label={props.labels.stop} title={props.labels.stop}>
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button
                className="pi-composer__send"
                onClick={submit}
                disabled={(!text.trim() && !props.hasAttachments) || props.preparing}
                aria-label={props.labels.send}
                title={props.running ? (props.labels.send === '发送' ? '发送追问（运行中排队）' : 'Send follow-up (queued)') : props.labels.send}
              >
                <Icon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Home welcome view (U03): mascot + greeting + composer + fixed-agent pills. */
export function HomeView(props: {
  greeting: string;
  composer: React.ReactNode;
  /** 固定 agent 快捷入口（对齐参考布局：输入卡下方一排胶囊）。 */
  presets?: { id: string; label: string; icon: IconName }[];
  onPickPreset?: (id: string) => void;
}) {
  return (
    <div className="pi-home">
      <div className="pi-home__center">
        <div className="pi-home__mascot">
          <PiBrandMark size={92} />
        </div>
        <div className="pi-home__greeting">{props.greeting}</div>
      </div>
      {props.composer}
      {props.presets && props.presets.length > 0 && (
        <div className="pi-home__presets" role="toolbar" aria-label={props.presets.length ? 'Fixed agents' : undefined}>
          {props.presets.map((p) => (
            <button key={p.id} className="pi-home__preset" onClick={() => props.onPickPreset?.(p.id)} title={p.label}>
              <Icon name={p.icon} size={13} />
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
