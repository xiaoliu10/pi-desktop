import { TerminalOutput } from './TerminalOutput';
import { ChatError } from './ChatError';
import { RetryStatus } from './RetryStatus';
import { retryPresentation } from '../../pi/model-retry';
import { retryErrorIds } from './error-groups';
import { WaitingProcess } from './WaitingProcess';
import { officialSubagentDetails, SubagentNavigation } from '../../pi/subagents';
/**
 * Chat replica components (U03): markdown rendering, tool cards, diffs,
 * message nav rail, composer with menus, and the conversation/home views.
 */

import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { navigatePromptHistory } from '../prompt-history';
import { onCloseTransientPopovers } from '../popovers';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ChatMessage,
  ChatViewProps,
  PiImage,
  ComposerProps,
  DemoFileDiff,
  ImageGenCardData,
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
  filterModelGroups,
  groupImageModels,
  MODEL_MENU_LIMIT,
  parseMenuState,
} from './helpers';
import './chat.css';
import { toolFilePreview } from '../../pi/tool-file-preview';
import { executionTurns, formatElapsed, type ChatTurn } from './execution';

const remarkGfmPlugins = [remarkGfm];

/** 从 ReactNode 树里递归抽取纯文本（代码块复制用；react-markdown 的 code 子节点是语法高亮前的纯文本）。 */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  const el = node as { props?: { children?: ReactNode } };
  return el.props ? extractText(el.props.children) : '';
}

/** markdown 围栏代码块外壳：右上角悬浮复制按钮，成功后 1.6s 打勾自复位。 */
// node 由 react-markdown (passNode) 注入，不能透传到 DOM——解构剔除。
function CodeBlockPre({ children, zh, node: _node, ...rest }: React.ComponentProps<'pre'> & { zh?: boolean; node?: unknown }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const text = useMemo(() => extractText(children), [children]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch (e) { console.warn('[CodeBlockPre] clipboard write failed', e); /* 复位不打断阅读，但留痕便于诊断 */ }
  };
  const label = copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制代码' : 'Copy code');
  return (
    <div className="pi-codeblock">
      <pre {...rest}>{children}</pre>
      <button type="button" className={`pi-codeblock__copy${copied ? ' pi-codeblock__copy--done' : ''}`} title={label} aria-label={label} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  );
}

/** 记忆化：文本不变时不重新解析 markdown（避免每次按键/流式更新都重解析全部消息）。 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, zh }: { text: string; zh?: boolean }) {
  // pre 覆写在每次渲染按当前 zh 重建 components：语言切换时按钮文案随之变化。
  const components = useMemo(() => ({ pre: (props: React.ComponentProps<'pre'> & { zh?: boolean }) => <CodeBlockPre {...props} zh={zh} /> }), [zh]);
  const content = useMemo(() => <ReactMarkdown remarkPlugins={remarkGfmPlugins} components={components}>{text}</ReactMarkdown>, [text, components]);
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

export function ToolCard({ part, labels, onOpenToolFile, live }: { part: ToolPart; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile']; /** 组流式中且这是最后一个 part：运行中的工具行展示加粗「正在执行」（与正在思考同款） */ live?: boolean }) {
  const openSubagents=useContext(SubagentNavigation);
  const zh = labels.you === '你';
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(part.argumentsText || '{}') || {}; } catch { /* Older sessions may only contain a summary. */ }
  const file = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : typeof args.filePath === 'string' ? args.filePath : '';
  const fileName = file.split('/').pop() || file;
  const directory = file.slice(0, -fileName.length);
  const command = typeof args.command === 'string' ? args.command : undefined;
  // codemode（JS 脚本调工具）：摘要显示脚本首条有效语句而非原始 JSON。
  const isCodeMode = part.tool === 'codemode';
  const code = isCodeMode && typeof args.code === 'string' ? args.code : undefined;
  const codeSummary = code ? code.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//'))?.slice(0, 90) : undefined;
  // pi ≥0.99 原生 MCP 工具名 `mcp__<server>__<tool>`：显示为「server / tool」并配插头图标。
  const mcpName = part.tool.startsWith('mcp__') ? part.tool.split('__').slice(1).filter(Boolean) : null;
  const icon = isCodeMode ? 'code' as const : mcpName ? 'plug' as const : ['bash','run_command'].includes(part.tool) ? 'terminal' : ['grep','find','ls'].includes(part.tool) ? 'search' : ['edit','write'].includes(part.tool) ? 'pencil' : part.tool === 'read' ? 'book' : 'plug';
  const toolLabel = mcpName ? mcpName.join(' / ') : zh ? ({ read: '读取', bash: '终端', run_command: '终端', edit: '编辑', write: '写入', grep: '查阅', find: '查阅', ls: '查阅', codemode: 'JS 脚本' } as Record<string, string>)[part.tool] : undefined;
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
          {live && part.status === 'running' && <strong className="pi-execution__thinking">{zh ? '正在执行' : 'Executing'}</strong>}
          <span className="pi-tool__name">{toolLabel || part.tool}</span>
          {file && <span className="pi-tool__file-icon" aria-hidden="true"><FileIcon path={file} size={17} /></span>}
          <span className="pi-tool__arg" title={file || codeSummary || command || part.summary}>{file ? <>{onOpenToolFile && toolFilePreview(part) ? <button type="button" className="pi-tool__file-link" title={toolFilePreview(part)?.current ? '在右侧查看文件及变更' : '在右侧查看本次文件修改'} onClick={event=>{event.preventDefault();event.stopPropagation();onOpenToolFile(part);}}>{fileName}</button> : fileName}<span className="pi-tool__directory">{directory}</span></> : codeSummary || command || part.summary}</span>
          {(additions > 0 || deletions > 0) && <span className="pi-tool__stat">{additions > 0 && <span className="pi-tool__stat--add">+{additions}</span>}{deletions > 0 && <span className="pi-tool__stat--del">−{deletions}</span>}</span>}
          <span className={`pi-tool__status pi-tool__status--${part.status}`}>
            {statusLabel}
          </span>
          <Icon name="chevron-right" size={12} className="pi-execution__chevron" />
        </summary>
        {officialSubagentDetails(part)&&openSubagents&&<button type="button" className="pi-btn pi-btn--ghost" onClick={()=>openSubagents(part.callId||part.id)}>查看子代理任务与过程</button>}
        <div className="pi-tool__detail">
          {isCodeMode && code
            ? <><h4>{zh ? '脚本' : 'Script'}</h4><pre className="pi-tool__output">{code}</pre></>
            : part.argumentsText && !['bash','run_command'].includes(part.tool) && <><h4>{zh ? '调用参数' : 'Input'}</h4><pre className="pi-tool__output">{part.argumentsText}</pre></>}
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

function MessageParts({ parts, labels, onOpenToolFile, live, hiddenErrors }: { parts: MessagePart[]; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile']; /** 组处于流式且这是最后一个 part：思考行滚动展示内容 */ live?: boolean; hiddenErrors?: Set<string> }) {
  return (
    <>
      {parts.map((p) => {
        switch (p.kind) {
          case 'image':
            return <img key={p.id} className="pi-message-image" src={`data:${p.mimeType};base64,${p.data}`} alt="附件图片" />;
          case 'text':
            return <ChatMarkdown key={p.id} text={p.text} zh={labels.you === '你'} />;
          case 'thinking':
            return <ExecutionNote key={p.id} zh={labels.you === '你'} title={`${labels.you === '你' ? '思考' : 'Thought'}${p.durationMs !== undefined ? ` · ${labels.you === '你' ? `用时 ${Math.max(1, Math.ceil(p.durationMs / 1000))} 秒` : `took ${Math.max(1, Math.ceil(p.durationMs / 1000))}s`}` : ''}`} text={p.text} active={live} />;
          case 'tool':
            return <ToolCard key={p.id} part={p} labels={labels} onOpenToolFile={onOpenToolFile} live={live} />;
          case 'notice':
            return p.strong ? (
              <div key={p.id} className="pi-notice pi-notice--strong" role="note">
                <Icon name="archive" size={15} />
                <span>{p.text}</span>
              </div>
            ) : (
              <div key={p.id} className="pi-notice">
                {p.text}
              </div>
            );
          case 'error':
            return hiddenErrors?.has(p.id) ? null : <ChatError key={p.id} part={p} zh={labels.you === '你'} />;
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
  // 视图切换（如进入设置页）时收起灯箱：fixed+全屏遮罩 z1000 会穿透设置页覆盖层。
  useEffect(() => onCloseTransientPopovers(() => setOpen(false)), []);
  const ext = part.mimeType === 'image/jpeg' ? 'jpg' : part.mimeType.slice('image/'.length);
  const name = `pi-image-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${ext}`;
  return <>
    <button type="button" className="pi-msg__imagebtn" title={labels.viewImage} aria-label={labels.viewImage} onClick={() => setOpen(true)}>
      <img className="pi-msg__image" src={dataUrl} alt="附件图片" />
    </button>
    {open && createPortal(
      <div className="pi-lightbox" role="dialog" aria-modal="true" aria-label={labels.viewImage} onClick={() => setOpen(false)}>
        <div className="pi-lightbox__bar" onClick={e => e.stopPropagation()}>
          {onDownload && <button type="button" className="pi-lightbox__btn" title={labels.downloadImage} aria-label={labels.downloadImage} onClick={() => onDownload(dataUrl, name)}><Icon name="download-cloud" size={22} /></button>}
          <button type="button" className="pi-lightbox__btn" title={labels.close} aria-label={labels.close} onClick={() => setOpen(false)}><Icon name="x" size={22} /></button>
        </div>
        <img className="pi-lightbox__img" src={dataUrl} alt="附件图片" onClick={e => e.stopPropagation()} />
      </div>,
      document.body,
    )}
  </>;
}

/** 直连生图结果卡片：图片网格 + 说明行，点击进灯箱（复用附件图片的灯箱/下载）。 */
function ImageGenCardView({ card, labels, onDownload }: { card: ImageGenCardData; labels: ChatViewProps['labels']; onDownload?: ChatViewProps['onDownloadImage'] }) {
  const zh = labels.you === '你';
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const close = () => setOpenIdx(null);
  useEffect(() => {
    if (openIdx === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openIdx]);
  useEffect(() => onCloseTransientPopovers(close), []);
  const stamp = new Date(card.at).toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const dataUrl = (i: number) => `data:${card.images[i].mime};base64,${card.images[i].data}`;
  const fileName = (i: number) => `pi-gen-${stamp}-${i + 1}.${card.images[i].mime === 'image/jpeg' ? 'jpg' : card.images[i].mime.slice('image/'.length)}`;
  const caption = `${zh ? '生成的图像' : 'Generated image'} · ${card.model} · ${card.prompt}`;
  return (
    <div className="pi-imagegen">
      <div className="pi-imagegen__images">
        {card.images.map((img, i) => (
          <button key={i} type="button" className="pi-msg__imagebtn" title={zh ? '点击放大' : 'Click to enlarge'} onClick={() => setOpenIdx(i)}>
            <img className="pi-msg__image" src={dataUrl(i)} alt={card.prompt.slice(0, 80) || caption} loading="lazy" />
          </button>
        ))}
      </div>
      <div className="pi-imagegen__caption" title={caption}>{caption}</div>
      {openIdx !== null && createPortal(
        <div className="pi-lightbox" role="dialog" aria-modal="true" aria-label={zh ? '生成的图像' : 'Generated image'} onClick={close}>
          <div className="pi-lightbox__bar" onClick={e => e.stopPropagation()}>
            {onDownload && <button type="button" className="pi-lightbox__btn" title={labels.downloadImage} aria-label={labels.downloadImage} onClick={() => onDownload(dataUrl(openIdx), fileName(openIdx))}><Icon name="download-cloud" size={22} /></button>}
            <button type="button" className="pi-lightbox__btn" title={labels.close} aria-label={labels.close} onClick={close}><Icon name="x" size={22} /></button>
          </div>
          <img className="pi-lightbox__img" src={dataUrl(openIdx)} alt={caption} onClick={e => e.stopPropagation()} />
        </div>,
        document.body,
      )}
    </div>
  );
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

function ExecutionNote({ title, text, active, zh }: { title: string; text: string; /** 这条思考正在流式输出：行内滚动展示内容尾部，完成后恢复计时标题 */ active?: boolean; zh?: boolean }) {
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
    <div className="pi-execution__note-body"><ChatMarkdown text={text} zh={zh} /></div>
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
  return <details open={open} onToggle={(e) => {
    // 回合进行中强制展开：浏览器原生 toggle 会先把 DOM 翻到折叠态（onToggle 异步），
    // 若不立即写回，用户点击会闪折/需点两下才能再开。直接在 DOM 上拉直。
    if (running) { e.currentTarget.open = true; return; }
    setUserOpen(e.currentTarget.open);
  }} className={`pi-execution ${running ? 'pi-execution--running' : ''} ${failures ? 'pi-execution--error' : ''}`}>
    <summary className="pi-execution__summary">
      {/* 「正在思考」粗体由活动思考行自己展示（滚动内容同行）；组头只保留计时，避免重复 */}
      {hasTiming ? <ElapsedTime startedAt={turn.startedAt} endedAt={turn.endedAt} running={live} zh={zh} /> : <span className="pi-execution__title">{live ? (zh ? '正在工作' : 'Working') : (zh ? `执行过程 · ${parts.length} 步` : `Execution · ${parts.length} steps`)}</span>}
      {failures > 0 && <span className="pi-execution__failure">{failures} {zh ? '项失败' : 'failed'}</span>}
      {live && <Spinner label={zh ? '运行中' : 'Running'} />}
      <Icon name="chevron-right" size={14} className="pi-execution__chevron" />
    </summary>
    <div className="pi-execution__steps">{renderSteps(parts, live, zh, labels, onOpenToolFile)}</div>
  </details>;
}

/** 工具的聚合分类：连续同类工具折叠成「查阅 · N 搜索」式子组（参考 ZCode）。 */
function toolCategory(part: ToolPart, zh: boolean): { key: string; label: string; noun: string; icon: 'search' | 'terminal' | 'book' | 'pencil' } | null {
  const search = { key: 'search', label: zh ? '查阅' : 'Search', noun: zh ? '搜索' : 'searches', icon: 'search' as const };
  if (['grep', 'find', 'ls', 'glob'].includes(part.tool)) return search;
  if (part.tool === 'read') return { key: 'read', label: zh ? '读取' : 'Read', noun: zh ? '个文件' : 'files', icon: 'book' as const };
  if (['edit', 'write'].includes(part.tool)) return { key: 'edit', label: zh ? '编辑' : 'Edit', noun: zh ? '处修改' : 'edits', icon: 'pencil' as const };
  if (['bash', 'run_command'].includes(part.tool)) {
    // 终端命令按内容嗅探：grep/rg/find/ls 等搜索类命令归「查阅」，其余归「终端」。
    let command = '';
    try { const args = JSON.parse(part.argumentsText || '{}') || {}; command = typeof args.command === 'string' ? args.command : ''; } catch { /* 无参数摘要时直接归终端 */ }
    const bin = command.trim().split(/[\s|;&]+/)[0]?.split('/').pop() ?? '';
    if (['grep', 'rg', 'ag', 'find', 'fd', 'ls', 'tree'].includes(bin)) return search;
    return { key: 'shell', label: zh ? '终端' : 'Terminal', noun: zh ? '条命令' : 'commands', icon: 'terminal' as const };
  }
  return null;
}

function ToolGroupBlock({ cat, items, last, zh, live, running, labels, onOpenToolFile }: { cat: { key: string; label: string; noun: string; icon: 'search' | 'terminal' | 'book' | 'pencil' }; items: Array<{ p: MessagePart; i: number }>; /** 整个 steps 的最后一个下标（加粗「正在执行」只落在它上） */ last: number; zh: boolean; live: boolean; running: boolean; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile'] }) {
  const anyRunning = items.some(({ p }) => p.kind === 'tool' && p.status === 'running');
  const [userOpen, setUserOpen] = useState(false);
  // 有子项在跑时钉住展开（正在执行的行必须可见）；完成态默认折叠，用户可开合。
  const open = (running && anyRunning) || userOpen;
  return <div className="pi-execution__subgroup">
    <button type="button" className="pi-execution__subhead" onClick={() => { if (!(running && anyRunning)) setUserOpen(o => !o); }}>
      <Icon name={cat.icon} size={15} />
      <span>{cat.label} · {items.length} {cat.noun}</span>
      <Icon name="chevron-right" size={12} className={`pi-execution__chevron ${open ? 'pi-execution__chevron--open' : ''}`} />
    </button>
    {open && <div className="pi-execution__subitems">
      {items.map(({ p, i }) => <MessageParts key={p.id} parts={[p]} labels={labels} onOpenToolFile={onOpenToolFile} live={partLive(p, i, live, last)} />)}
    </div>}
  </div>;
}

/** 每部分的 live 语义：tool 跟「组流式 + 自身运行中」走（加粗正在执行）；thinking 仍只最后一条（滚动 ticker 只出现一处）。 */
function partLive(p: MessagePart, i: number, live: boolean, last: number): boolean {
  return p.kind === 'tool' ? live : live && i === last;
}

/** 步骤渲染：连续同类工具（≥2）折叠成子组，其余按原样逐条渲染。 */
function renderSteps(parts: MessagePart[], live: boolean, zh: boolean, labels: ChatViewProps['labels'], onOpenToolFile?: ChatViewProps['onOpenToolFile']) {
  const out: ReactNode[] = [];
  const last = parts.length - 1;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i]!;
    if (p.kind !== 'tool') {
      out.push(p.kind === 'text'
        ? <div key={p.id} className="pi-execution__commentary"><ChatMarkdown text={p.text} zh={labels.you === '你'} /></div>
        : <MessageParts key={p.id} parts={[p]} labels={labels} onOpenToolFile={onOpenToolFile} live={partLive(p, i, live, last)} />);
      i += 1;
      continue;
    }
    const cat = toolCategory(p, zh);
    if (!cat) {
      out.push(<MessageParts key={p.id} parts={[p]} labels={labels} onOpenToolFile={onOpenToolFile} live={partLive(p, i, live, last)} />);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < parts.length) {
      const q = parts[j]!;
      if (q.kind !== 'tool') break;
      const cq = toolCategory(q, zh);
      if (!cq || cq.key !== cat.key) break;
      j += 1;
    }
    if (j - i >= 2) {
      out.push(<ToolGroupBlock key={`grp-${p.id}`} cat={cat} items={parts.slice(i, j).map((pp, k) => ({ p: pp, i: i + k }))} last={last} zh={zh} live={live} running={live} labels={labels} onOpenToolFile={onOpenToolFile} />);
    } else {
      out.push(<MessageParts key={p.id} parts={[p]} labels={labels} onOpenToolFile={onOpenToolFile} live={partLive(p, i, live, last)} />);
    }
    i = j;
  }
  return out;
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
export const TurnArticle = memo(function TurnArticle({ m, liveTurn, retrying, suppressModelErrors, retryingError, labels, onOpenToolFile, onEditUser, editCorrection, onDownloadImage }: { m: ChatTurn; liveTurn: boolean; retrying?: boolean; suppressModelErrors?: boolean; /** 本次重试的错误首行：只藏末尾同类的失败，异类错误保持可见。 */ retryingError?: string; labels: ChatViewProps['labels']; onOpenToolFile?: ChatViewProps['onOpenToolFile']; /** 提供时用户消息可「编辑并重发」（先 fork 截断再发送，等价 ZCode 编辑语义）。 */ onEditUser?: (entryId: string, text: string) => void; /** 任务运行中：提交不再是 fork 重发而是作为更正发送（fork 会截断在跑 agent 的上下文）。 */ editCorrection?: boolean; onDownloadImage?: ChatViewProps['onDownloadImage'] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const zh = labels.you === '你';
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
                <button className="pi-btn pi-btn--primary" onClick={submit} disabled={!draft.trim()}>{editCorrection ? (zh ? '发送更正' : 'Send correction') : labels.resend}</button>
                <button className="pi-btn pi-btn--ghost" onClick={() => setEditing(false)}>{labels.cancel}</button>
              </div>
            </div>
            : <UserMessageParts parts={m.answer} labels={labels} onOpenToolFile={onOpenToolFile} onDownloadImage={onDownloadImage} />}
          {!editing && (userText || onEditUser) && (
            <div className="pi-msg__actions">
              {userText && <button type="button" className="pi-msg__action" title={copied ? labels.copied : labels.copyMessage} aria-label={labels.copyMessage} onClick={() => void copy()}>{copied ? <><Icon name="check" size={13} /><span>{labels.copied}</span></> : <Icon name="copy" size={13} />}</button>}
              {onEditUser && userText && <button type="button" className="pi-msg__action" title={editCorrection ? (zh ? '编辑并发送更正' : 'Edit and send correction') : labels.editMessage} aria-label={editCorrection ? (zh ? '编辑并发送更正' : 'Edit and send correction') : labels.editMessage} onClick={() => { setDraft(userText); setEditing(true); }}><Icon name="pencil" size={13} /></button>}
            </div>
          )}
        </>
        : (() => {
          if (liveTurn) {
            const hiddenErrors = retrying || suppressModelErrors ? new Set([
              ...retryErrorIds(m.segments.flatMap(segment => segment.parts), retryingError),
              ...m.segments.flatMap(segment => segment.parts).filter(part => part.kind === 'error' && part.source === 'model').map(part => part.id),
            ]) : undefined;
            // 活动轮：保持时间顺序，逐步段渲染；所有过程段保持展开（用户要求：
            // 工作进行中进度可见，中途出现结论文字也不折叠，完成态才统一收起）
            return <>{m.segments.map((seg, si) => {
              const liveSegment = si === m.segments.length - 1;
              if (seg.kind === 'steps' && seg.parts.length > 0) {
                return <ExecutionGroup key={`${m.id}-seg-${si}`} turn={m} parts={seg.parts} running={liveSegment && !retrying} active={liveSegment && !retrying} expanded showElapsed={liveSegment && !retrying} labels={labels} onOpenToolFile={onOpenToolFile} />;
              }
              if (seg.kind === 'text' && seg.parts.length > 0) {
                if (seg.parts.every(part => hiddenErrors?.has(part.id))) return null;
                return <div key={`${m.id}-seg-${si}`} className="pi-msg__answer"><MessageParts parts={seg.parts} labels={labels} onOpenToolFile={onOpenToolFile} hiddenErrors={hiddenErrors} /></div>;
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
    let userScrollUntil = 0;
    let frame = 0;
    const markUserScroll = () => { userScrollUntil = performance.now() + 1000; };
    const onWheel = (event: WheelEvent) => {
      markUserScroll();
      if (event.deltaY < 0) followingRef.current = false;
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
        followingRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      }
      // 离开底部 → 显示跳转按钮；回到底部 → 隐藏
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      setShowJump((prev) => (prev === !nearBottom ? prev : !nearBottom));
    };
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (followingRef.current) list.scrollTop = list.scrollHeight; });
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

  const seenScrollRequests = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (!props.scrollRequest || !listRef.current || seenScrollRequests.current.has(props.scrollRequest)) return;
    seenScrollRequests.current.add(props.scrollRequest);
    followingRef.current = true;
    listRef.current.scrollTop = listRef.current.scrollHeight;
    setShowJump(false);
  }, [props.scrollRequest]);

  const retryUI = retryPresentation(props.retryGroup, props.retrying, props.stopping);
  const turns = useMemo(() => {
    const result = executionTurns(props.messages);
    const last = result[result.length - 1];
    const timing = props.runTiming;
    if (last?.role === 'assistant' && timing && ((last.endedAt ?? 0) >= timing.startedAt || (last.startedAt ?? 0) >= timing.startedAt - 1000)) {
      result[result.length - 1] = { ...last, startedAt: timing.startedAt, endedAt: timing.endedAt };
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
            <TurnArticle key={m.id} m={m} liveTurn={Boolean(props.running || retryUI.recovering) && !props.sendingText && m === turns[turns.length - 1]} retrying={retryUI.visible && retryUI.recovering && m === turns[turns.length - 1]} suppressModelErrors={retryUI.recovering && m === turns[turns.length - 1]} retryingError={retryUI.retry?.error} labels={props.labels} onOpenToolFile={props.onOpenToolFile} onEditUser={props.onEditUserMessage} editCorrection={Boolean(props.running)} onDownloadImage={props.onDownloadImage} />
          ))}
          {props.sending && props.sendingText && (
            <article className="pi-msg pi-msg--user pi-msg--pending">
              <UserMessageParts parts={[{ kind: 'text', id: 'pi-pending-prompt', text: props.sendingText }]} labels={props.labels} onOpenToolFile={props.onOpenToolFile} />
            </article>
          )}
          {props.steeringText && (
            /* 点「立即」即时反馈：以已发送的正常样式立刻入流（含图片），不等 pi 确认；
               真实条目落盘后由 settle 交换。备注只留「已插入」确认感，生效细节收进 title。 */
            <article className="pi-msg pi-msg--user pi-msg--sent" title={props.labels.you === '你' ? '将在当前步骤结束后生效' : 'Takes effect after the current step'}>
              <UserMessageParts parts={[
                { kind: 'text', id: 'pi-pending-steer', text: props.steeringText },
                ...(props.steeringImages ?? []).map((image, n) => ({ kind: 'image' as const, id: `pi-pending-steer-img-${n}`, data: image.data, mimeType: image.mimeType })),
              ]} labels={props.labels} onOpenToolFile={props.onOpenToolFile} />
              <div className="pi-chat__steernote"><Icon name="check" size={12} /> {props.labels.you === '你' ? '已插入当前任务' : 'Inserted into the current task'}</div>
            </article>
          )}
          {(() => {
            // 发送后立刻转圈计时；一旦执行组（steps）开始流式输出，计时交还给组内，避免重复。
            const lastTurn = turns[turns.length - 1];
            const stepsLive = (lastTurn?.segments.at(-1)?.kind ?? 'text') === 'steps';
            if (retryUI.visible) return <RetryStatus retry={props.retrying} group={props.retryGroup} stopping={props.stopping} onStop={props.onStop} zh={props.labels.you === '你'} />;
            if (!props.sending && !props.running) return null;
            const timerStart = props.runTiming?.startedAt ?? props.sendingAt;
            const zh = props.labels.you === '你';
            const working = (
              <div className="pi-chat__working" role="status" aria-label={props.labels.working}>
                <Spinner />
                {props.compacting && <span>{zh ? '正在压缩上下文…' : 'Compacting context…'}</span>}
                {props.queued > 0 && <span>{props.queued} {props.labels.queued}</span>}
                {!stepsLive && !props.compacting && timerStart !== undefined && <ElapsedTime startedAt={timerStart} running zh={zh} />}
                <span className="pi-chat__caret" />
              </div>
            );
            const hasProcess = !props.sendingText && lastTurn?.role === 'assistant' && lastTurn.steps.length > 0;
            return hasProcess || props.compacting ? working : <WaitingProcess zh={zh} onRefresh={props.onRefreshProcess}>{working}</WaitingProcess>;
          })()}
          {(props.imageCards ?? []).map(card => <ImageGenCardView key={card.id} card={card} labels={props.labels} onDownload={props.onDownloadImage} />)}
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
  useEffect(() => {
    if (props.draftText === undefined) return;
    // 历史回填经 200ms debounce 回流的 store 值与本地一致，跳过以免误清历史浏览态；
    // 真正的外部注入（队列召回/草稿恢复）值不同，照常同步并退出浏览态。
    if (props.draftText === draftRef.current) return;
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    draftRef.current = props.draftText;
    historyIndexRef.current = null; // 外部注入（队列召回/草稿恢复）退出历史浏览态
    setLocalText(props.draftText);
  }, [props.draftText]);
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
  const [menuIndex, setMenuIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // ↑/↓ 发送历史：null = 未进入历史浏览态；仅在空输入或已进入浏览态时接管方向键，
  // 避免抢走多行输入的光标移动（对齐 ZCode PromptHistoryPlugin）。
  const promptHistory = props.promptHistory;
  const historyIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (historyIndexRef.current !== null && promptHistory?.[historyIndexRef.current] === undefined) {
      historyIndexRef.current = null;
    }
  }, [promptHistory]);
  const applyHistoryEntry = (nextIndex: number | null, nextValue: string) => {
    historyIndexRef.current = nextIndex;
    setText(nextValue);
    // 程序化赋值不触发 onChange/input，手动把光标移到末尾并适配高度（对齐 ZCode selectEnd）。
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      autoResize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };
  const popup = parseMenuState(text);
  // The files prop seeds the mention list; window.pi enrichment (when present)
  // can extend it, but the prop alone must work (production passes []).
  const [scannedFiles, setScannedFiles] = useState<string[] | null>(null);
  const files = scannedFiles ?? props.files;
  const commands = popup.kind === 'slash' ? filterCommands(props.slashCommands, popup.query) : [];
  // 自愈：面板打开但命令列表为空时请父层重拉一次（每次弹窗至多一次，列表到位后不再触发）。
  const refreshedEmpty = useRef(false);
  useEffect(() => {
    if (popup.kind !== 'slash') { refreshedEmpty.current = false; return; }
    if (!refreshedEmpty.current && props.slashCommands.length === 0 && props.onSlashCommandsEmpty) {
      refreshedEmpty.current = true;
      props.onSlashCommandsEmpty();
    }
  }, [popup.kind, props.slashCommands.length, props.onSlashCommandsEmpty]);
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

  const [imageBusy, setImageBusy] = useState(false);
  const submit = () => {
    flushDraft();
    const value = text.trim();
    if ((!value && !props.hasAttachments) || props.preparing || imageBusy) return;
    historyIndexRef.current = null;
    setMenu(null);
    // 生图模式：发送 = 一次直连生图请求；失败文本保留（错误已由父层 notify），成功清空。
    if (props.imageTarget && props.onImageGenerate) {
      setImageBusy(true);
      props.onImageGenerate(value)
        .then(() => { setText(''); if (taRef.current) taRef.current.style.height = 'auto'; })
        .catch(() => { /* 保留输入 */ })
        .finally(() => setImageBusy(false));
      return;
    }
    setText('');
    props.onSend(value);
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  // Keyboard navigation for the model / reasoning popover. The model list is
  // truncated per provider (MODEL_MENU_LIMIT) and searchable by name/id —
  // modelItems reflects what is actually on screen. 生图模型以独立区块接在
  // 聊天模型之后，键盘导航合并计数。
  const [modelQuery, setModelQuery] = useState('');
  const visibleGroups = useMemo(() => filterModelGroups(props.modelGroups, menu === 'model' ? modelQuery : ''), [props.modelGroups, modelQuery, menu]);
  const modelItems = useMemo(() => visibleGroups.flatMap((g) => g.models), [visibleGroups]);
  const imageGroups = useMemo(() => groupImageModels(props.imageModels ?? []), [props.imageModels]);
  const visibleImageGroups = useMemo(() => filterModelGroups(imageGroups, menu === 'model' ? modelQuery : ''), [imageGroups, modelQuery, menu]);
  const imageItems = useMemo(() => visibleImageGroups.flatMap((g) => g.models), [visibleImageGroups]);
  const activeImage = useMemo(() => (props.imageModels ?? []).find((m) => m.key === props.imageTarget), [props.imageModels, props.imageTarget]);
  const reasonItems = ['off', 'low', 'medium', 'high'] as const;
  const openMenu = (kind: OpenMenu) => {
    setMenu(kind);
    if (kind === 'model') {
      setModelQuery('');
      if (activeImage) {
        // 目标在截断前的组内位置 → 映射回截断后的可见行（组内最多展示前 LIMIT 个）。
        const flat = groupImageModels(props.imageModels ?? []);
        let before = 0;
        let idx = 0;
        for (const g of flat) {
          const gi = g.models.findIndex((m) => m.id === props.imageTarget);
          if (gi >= 0) { idx = before + Math.min(gi, MODEL_MENU_LIMIT - 1); break; }
          before += Math.min(g.models.length, MODEL_MENU_LIMIT);
        }
        setMenuIndex(modelItems.length + idx);
      } else {
        const all = props.modelGroups.flatMap((g) => g.models);
        setMenuIndex(Math.max(0, all.findIndex((m) => m.id === props.modelId) % Math.max(1, MODEL_MENU_LIMIT)));
      }
    } else if (kind === 'reasoning') {
      const idx = reasonItems.indexOf(props.reasoning);
      setMenuIndex(idx >= 0 ? idx : 0);
    }
  };
  useEffect(() => {
    if (menu) menuRef.current?.focus();
  }, [menu]);
  // 高亮项跟随滚动（长列表键盘导航时保持可见）。
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(`[data-menu-idx="${menuIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [menuIndex, modelQuery, menu]);
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const inInput = e.target instanceof HTMLInputElement;
    if (menu === 'model' && inInput && e.key === ' ') return; // 输入框里的空格是打字
    const count = menu === 'model' ? modelItems.length + imageItems.length : menu === 'reasoning' ? reasonItems.length : 0;
    if (e.key === 'Escape' && menu === 'model' && inInput && modelQuery) {
      e.preventDefault();
      setModelQuery('');
      setMenuIndex(0);
      return;
    }
    if (!count) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMenuIndex((i) => (i + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMenuIndex((i) => (i - 1 + count) % count);
    } else if (e.key === 'Enter' || (e.key === ' ' && !inInput)) {
      e.preventDefault();
      if (menu === 'model') {
        if (menuIndex < modelItems.length) {
          const m = modelItems[menuIndex];
          if (m) { props.onPickModel(m.id); setMenu(null); }
        } else {
          const m = imageItems[menuIndex - modelItems.length];
          if (m) { props.onPickImageModel?.(props.imageTarget === m.id ? null : m.id); setMenu(null); }
        }
      } else if (menu === 'reasoning') {
        const lv = reasonItems[menuIndex];
        props.onPickReasoning(lv);
        setMenu(null);
      }
      taRef.current?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setMenu(null);
      taRef.current?.focus();
    }
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
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing && promptHistory?.length) {
      const currentIndex = historyIndexRef.current;
      // 历史导航只在“空输入”或“已进入历史浏览态”时接管上下键，避免抢走多行光标移动。
      if (currentIndex !== null || text.length === 0) {
        const result = navigatePromptHistory(promptHistory, currentIndex, e.key === 'ArrowUp' ? 'up' : 'down');
        if (result.shouldHandle) {
          e.preventDefault();
          applyHistoryEntry(result.nextIndex, result.nextValue);
          return;
        }
      }
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
        <div className="pi-composer__menu" role="menu" tabIndex={-1} ref={menuRef} onKeyDown={onMenuKeyDown}>
          <button
            className="pi-composer__menurow"
            role="menuitem"
            onClick={() => openMenu('model')}
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
              <input
                className="pi-composer__menuinput"
                value={modelQuery}
                placeholder="按名称或 ID 筛选模型…"
                aria-label="筛选模型"
                spellCheck={false}
                autoFocus
                onChange={(e) => { setModelQuery(e.target.value); setMenuIndex(0); }}
              />
              {visibleGroups.map((g) => (
                <div key={g.provider}>
                  <div className="pi-composer__menugroup">{g.provider}{g.total > g.models.length ? ` · ${g.models.length}/${g.total}` : ''}</div>
                  {g.models.map((m) => {
                    const flatIdx = modelItems.findIndex((x) => x.id === m.id);
                    return (
                    <button
                      key={m.id}
                      data-menu-idx={flatIdx}
                      className={`pi-composer__menurow pi-composer__menurow--sub ${m.id === props.modelId ? 'pi-composer__menurow--on' : ''} ${flatIdx === menuIndex ? 'pi-composer__menurow--active' : ''}`}
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
                    );
                  })}
                  {g.truncated > 0 && <div className="pi-composer__menuhint">还有 {g.truncated} 个模型，输入名称筛选</div>}
                </div>
              ))}
              {(props.imageModels?.length ?? 0) > 0 && (
                <div>
                  <div className="pi-composer__menugroup">{props.labels.imageGen ?? '图像生成'}</div>
                  {visibleImageGroups.map((g) => (
                    <div key={`img-${g.provider}`}>
                      {visibleImageGroups.length > 1 && <div className="pi-composer__menugroup pi-composer__menugroup--sub">{g.provider}{g.total > g.models.length ? ` · ${g.models.length}/${g.total}` : ''}</div>}
                      {g.models.map((m) => {
                        const flatIdx = modelItems.length + imageItems.findIndex((x) => x.id === m.id);
                        const on = props.imageTarget === m.id;
                        return (
                          <button
                            key={m.id}
                            data-menu-idx={flatIdx}
                            className={`pi-composer__menurow pi-composer__menurow--sub ${on ? 'pi-composer__menurow--on' : ''} ${flatIdx === menuIndex ? 'pi-composer__menurow--active' : ''}`}
                            role="menuitemradio"
                            aria-checked={on}
                            onClick={() => {
                              props.onPickImageModel?.(on ? null : m.id);
                              setMenu(null);
                            }}
                          >
                            <Icon name="image" size={14} />
                            <span>{m.name}</span>
                            {on && <Icon name="check" size={13} />}
                          </button>
                        );
                      })}
                      {g.truncated > 0 && <div className="pi-composer__menuhint">还有 {g.truncated} 个模型，输入名称筛选</div>}
                    </div>
                  ))}
                </div>
              )}
              {!visibleGroups.length && !imageItems.length && <div className="pi-composer__menuhint">没有匹配「{modelQuery}」的模型</div>}
              {props.onRefreshModels && menu === 'model' && (
                <button
                  className="pi-composer__menurow"
                  role="menuitem"
                  onClick={() => { props.onRefreshModels?.(); setMenu(null); }}
                >
                  <Icon name="refresh" size={14} />
                  <span>{props.labels.refreshModels ?? '刷新模型列表'}</span>
                </button>
              )}
              {!props.hideReasoning && (
                <button
                  className="pi-composer__menurow"
                  role="menuitem"
                  onClick={() => openMenu('reasoning')}
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
                  className={`pi-composer__menurow pi-composer__menurow--sub ${lv === props.reasoning ? 'pi-composer__menurow--on' : ''} ${reasonItems.indexOf(lv) === menuIndex ? 'pi-composer__menurow--active' : ''}`}
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
          placeholder={imageBusy
            ? (props.labels.imageGenBusy ?? '正在生成图像…')
            : props.imageTarget
              ? (props.labels.placeholderImage ?? '描述想生成的图像…')
              : props.sessionActive ? props.labels.placeholderSession : props.labels.placeholderHome}
          aria-label={props.labels.send}
          onChange={(e) => {
            historyIndexRef.current = null; // 用户手动编辑即退出历史浏览态（历史回填不触发 onChange）
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
              className={`pi-composer__pill pi-composer__pill--model ${menu === 'model' ? 'pi-composer__pill--on' : ''} ${activeImage ? 'pi-composer__pill--on' : ''}`}
              onClick={() => (menu === 'model' ? setMenu(null) : openMenu('model'))}
              aria-expanded={menu === 'model'}
              title={activeImage?.name ?? (pendingModel ? (props.labels.pendingSwitch ? `${props.labels.pendingSwitch}：${pendingModel.name}` : pendingModel.name) : (activeModel?.name ?? props.labels.model))}
            >
              {activeImage ? <Icon name="image" size={14} /> : <Icon name="bot" size={14} />}
              <span>{activeImage ? `${props.labels.imageGen ?? '生图'} · ${activeImage.name}` : pendingModel ? pendingModel.name : activeModel?.name ?? props.labels.model}</span>
              {pendingModel && !activeImage && <span className="pi-composer__pending">{props.labels.pendingSwitch ?? '待生效'}</span>}
              <Icon name="chevron-down" size={13} />
            </button>
            {!props.hideReasoning && (
              <button
                className={`pi-composer__pill pi-composer__pill--reasoning ${menu === 'reasoning' ? 'pi-composer__pill--on' : ''}`}
                onClick={() => (menu === 'reasoning' ? setMenu(null) : openMenu('reasoning'))}
                aria-expanded={menu === 'reasoning'}
                title={props.labels.reasoning}
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
            {typeof props.voiceSlot === 'function' ? props.voiceSlot(transcript => {
              const current = draftRef.current;
              const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${transcript}`;
              if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
              draftRef.current = next;
              setLocalText(next);
              props.onDraftChange?.(next);
              taRef.current?.focus();
            }) : props.voiceSlot}
            {/* One morphing action button, like the reference: while anything
                is in flight (working bar up: running or still-sending) it is
                Stop; typing a follow-up turns it into Send (queued), clearing
                text returns it to Stop. */}
            {(props.running || props.sending) && !text.trim() && !props.hasAttachments ? (
              <button className="pi-composer__send pi-composer__send--stop" onClick={props.onStop} aria-label={props.labels.stop} title={props.labels.stop}>
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button
                className="pi-composer__send"
                onClick={submit}
                disabled={(!text.trim() && !props.hasAttachments) || props.preparing || imageBusy}
                aria-label={props.labels.send}
                title={imageBusy ? (props.labels.imageGenBusy ?? '正在生成图像…') : props.running ? (props.labels.send === '发送' ? '发送追问（运行中排队）' : 'Send follow-up (queued)') : props.labels.send}
              >
                <Icon name={imageBusy ? 'loader' : 'send'} size={16} />
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
