import { SubagentPanel } from './SubagentPanel';
import { projectSubagents, SubagentNavigation } from './subagents';
import { AccountLoginDialog } from './AccountLoginDialog';
import { ConversationStatusPanel } from './ConversationStatusPanel';
import { TerminalPanel } from './TerminalPanel';
import { PlanViewer } from './PlanViewer';
import { PlanCard } from './PlanCard';
import { PlanApprovalCard } from './PlanApprovalCard';
import { planDocument, planFromMarkdown } from './plan-document';
import { conversationPlan } from './conversation-plan';
import { AutomationsPage } from './AutomationsPage';
import { toolFilePreview } from './tool-file-preview';
import { ProjectActions } from './ProjectActions';
import { OpenWithMenu } from './OpenWithMenu';
import { ProviderLogo } from './ProviderLogo';
import { ArchivedSessions } from './ArchivedSessions';
import { ComposerAdd, ContextChips, ContextUsageChip, ProjectHeader, ThinkingMenu } from './ComposerTools';
import { AccessModeMenu } from './AccessModeMenu';
import { SettingsFeatures } from './SettingsFeatures';
import { RemotePane } from './RemotePane';
import { DEFAULT_SHORTCUTS, DEFAULT_AGENT_PRESETS, shortcutMatches, type ShortcutAction } from '../../shared/settings';
/**
 * Production entry view (P08): the accepted replica UI driven by the real
 * local pi backend (window.localPi) through src/renderer/pi/adapter.ts.
 *
 * The demo preview (?preview=1) stays separate with fixture data. Here every
 * control maps to a real backend capability; capabilities that do not exist
 * yet (file content preview, proxy config, marketplace) are disabled with an
 * explanation instead of pretending.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../replica/Icons';
import { appendPromptHistoryEntry, persistPromptHistory, readPromptHistory } from '../replica/prompt-history';
import { replicaLabels } from '../replica/i18n';
import { Sidebar } from '../replica/shell/Sidebar';
import { ResizeHandle, usePanelWidth } from '../replica/shell/ResizeHandle';
import { TopBar } from '../replica/shell/TopBar';
import { ChatView, Composer, HomeView } from '../replica/chat/ChatView';
import { VoiceInputButton } from './VoiceInputButton';
import { PluginsPage } from '../replica/plugins/PluginsPage';
import { SettingsPage } from '../replica/settings/SettingsPage';
import { WorkbenchPanel } from '../replica/workbench/WorkbenchPanel';
import { BrowserPanel } from './BrowserPanel';
import { GlobalSearch, Notifications } from '../replica/overlays/Overlays';
import type {
  SearchItem,
  SessionNavItem,
  SettingsSectionData,
  SettingsNavId,
  PluginRowData,
  ProviderCardData,
} from '../replica/contracts';
import type { AccessMode } from '../../shared/access-mode';
import {
  buildPiSidebar,
  canNavBack,
  canNavForward,
  automationLaunchPrompt,
  currentRunOf,
  currentSessionOf,
  cwdOf,
  groupModels,
  sentConversationMessages,
  parseUnifiedDiff,
  reviewDiffEntries,
  resourcesToPluginRows,
  sessionTitleOf,
  usePiStore,
  type Dialog,
} from './adapter';
import type { PiCatalogProvider } from '../../shared/pi';
import './replica-app.css';
import '../replica/tokens.css';

function labelsFor(lang: 'en' | 'zh') {
  const t = replicaLabels(lang);
  if (lang === 'zh') {
    return {
      ...t,
      plugins: {
        ...t.plugins,
        demoNote: '直接读取本机 pi 资源；已发现不等于已加载，仅 RPC 注册的命令可调用。',
        emptyInstalledHint: '使用终端 pi install 安装资源后，点击“重新扫描”。',
        needsAttention: '读取失败',
        updatesAvailable: '已发现 · 未确认加载',
        active: '命令可调用',
        turnedOff: '已排除 / 缺失',
        update: '重载',
      },
      settings: {
        ...t.settings,
        runtime: 'pi 运行环境',
        demoEnv: '模型、认证与扩展由本机 pi 管理；Desktop 共享同一份配置。',
        noVendor: '模型与认证由本机 pi CLI 管理，不复制到 Desktop。',
        aiProviders: 'AI 提供商（来自 pi）',
      },
      workbench: {
        ...t.workbench,
        emptyFiles: '文件浏览暂未开放',
        emptyFilesHint: '当前桌面与 pi 的桥接尚未提供文件内容读取能力。',
      },
    };
  }
  return {
    ...t,
    plugins: {
      ...t.plugins,
      demoNote: 'Resources come from your local pi installation; discovered does not mean loaded.',
      emptyInstalledHint: 'Install with `pi install` in a terminal, then rescan.',
      needsAttention: 'Failed to read',
      updatesAvailable: 'Discovered · load unconfirmed',
      active: 'Commands callable',
      turnedOff: 'Excluded / missing',
      update: 'Reload',
    },
    settings: {
      ...t.settings,
      runtime: 'pi runtime',
      demoEnv: 'Models, auth and extensions are managed by your local pi; the desktop shares that configuration.',
      noVendor: 'Models and auth are managed by the pi CLI and never copied to the desktop.',
      aiProviders: 'AI providers (from pi)',
    },
    workbench: {
      ...t.workbench,
      emptyFiles: 'File browsing not available yet',
      emptyFilesHint: 'The desktop↔pi bridge does not expose file contents yet.',
    },
  };
}

// 稳定回调：避免击穿 ChatView 的 memo。
const noop = () => undefined;

export default function PiReplicaApp() {
  const s = usePiStore();
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const attachmentBusy = useRef(false);
  const pasteAttachments: import('react').ClipboardEventHandler<HTMLTextAreaElement> = event => {
    const files = Array.from(event.clipboardData.files);
    const types = Array.from(event.clipboardData.types);
    if (!files.length && event.clipboardData.getData('text/plain') && !types.includes('text/uri-list')) return;
    event.preventDefault();
    if (attachmentBusy.current) return;
    attachmentBusy.current = true;
    setAttachmentLoading(true);
    const origin = usePiStore.getState();
    void (async () => {
      try {
        if (files.length > 10 || files.some(f => f.size > 10*1024*1024) || files.reduce((n,f)=>n+f.size,0) > 20*1024*1024) throw new Error('一次最多添加 10 个附件，单个不超过 10 MiB，总计不超过 20 MiB。');
        const items = files.length
          ? await window.localPi!.importAttachments(await Promise.all(files.map(async file => ({name:file.name,bytes:new Uint8Array(await file.arrayBuffer())}))))
          : await window.localPi!.clipboardAttachments();
        const current = usePiStore.getState();
        if (current.selectedKey !== origin.selectedKey || current.draftCwd !== origin.draftCwd) return;
        if (current.contextItems.length + items.length > 10) throw new Error('最多添加 10 个附件，请移除部分附件。');
        if ([...current.contextItems,...items].reduce((n,item)=>n+(item.image?.data.length || 0),0) > 10*1024*1024) throw new Error('图片总大小超过 10 MiB，请减少图片。');
        current.addContext(items);
      } catch (error) { usePiStore.setState({error: String((error as Error).message || error)}); }
      finally { attachmentBusy.current = false; setAttachmentLoading(false); }
    })();
  };

  const t = labelsFor(s.lang);
  const run = currentRunOf(s);
  const session = currentSessionOf(s);
  const cwd = cwdOf(s);
  const title = sessionTitleOf(s);
  // hiddenInset window: macOS traffic lights float over the top-left corner.
  // The settings nav starts there ("返回应用"), so the settings view reserves
  // a drag strip on macOS. The browser preview is unaffected.
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
  const rootClass = `pireplica ${s.theme === 'dark' ? 'pireplica--dark' : ''} ${isMac ? 'pireplica--mac' : ''} ${s.sidebarCollapsed ? 'pireplica--sidebar-collapsed' : ''}`;

  // -- init & hotkeys ---------------------------------------------------------
  const init = usePiStore((st) => st.init);
  useEffect(() => {
    init();
  }, [init]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 仅当阻塞交互属于当前会话时才禁用快捷键；后台会话的提问不应锁住当前会话（会话级分摊）。
      const hasSessionDialog = Boolean(s.selectedKey) && s.dialogs.some((d) => d.key === s.selectedKey);
      if (e.isComposing || e.repeat || hasSessionDialog || document.querySelector('dialog[open]')) return;
      if (document.body.dataset.shortcutRecording) return; // shortcuts page is capturing a new binding
      const bindings = s.desktopPreferences?.shortcuts || DEFAULT_SHORTCUTS;
      const action = (Object.keys(bindings) as ShortcutAction[]).find(a => shortcutMatches(e, bindings[a]));
      if (!action) return;
      e.preventDefault();
      if (action === 'search') s.setSearchOpen(!s.searchOpen);
      else if (action === 'newSession') s.startNewSession();
      else if (action === 'settings') s.openSettings('general');
      else if (action === 'workbench') s.toggleWorkbench();
      else if (action === 'sidebar') s.toggleSidebar();
      else if (action === 'stop' && run) s.stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [s]);

  const sidebar = useMemo(() => {
    const result = buildPiSidebar(s.sessions.filter(session=>!s.archivedKeys.includes(session.key)), s.runs.filter(run=>!s.archivedKeys.includes(run.key)), s.expandedProjects, s.renames);
    // 阻塞交互胶囊（ZCode getTaskListAttention）：哪个会话在等用户确认，就在哪一行提示。
    const attention = pendingAttentionBySession(s.dialogs);
    const markAttention = (items: SessionNavItem[]) => items.map((item) => attention[item.id] ? { ...item, ...attention[item.id] } : item);
    result.temporary = markAttention(result.temporary);
    for (const project of result.projects) project.sessions = markAttention(project.sessions);
    const projectMeta=new Map<string,import('../../shared/projects').DesktopProject>();
    for(const session of s.sessions)projectMeta.set(session.cwd,{path:session.cwd,name:pathLabel(session.cwd)});
    for(const project of s.desktopPreferences?.projects??[])projectMeta.set(project.path,project);
    for (const p of projectMeta.values()) {
      const found = result.projects.find(x => x.path === p.path);
      if (found) Object.assign(found,{name:p.name,pinned:p.pinned,section:p.section});
      else result.projects.push({ id: p.path, name: p.name, path: p.path, pinned:p.pinned, section:p.section, expanded: s.expandedProjects.includes(p.path), emptyHint: true, sessions: [] });
    }
    const hidden=s.desktopPreferences?.hiddenProjects??[];
    result.projects=result.projects.filter(p=>!hidden.includes(p.path)).sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||(a.pinned?0:(a.section||'\uffff').localeCompare(b.section||'\uffff')));
    result.temporary=result.temporary.filter(item=>!hidden.includes(s.runs.find(r=>r.key===item.id)?.cwd??''));
    return result;
  }, [s.sessions, s.runs, s.expandedProjects, s.renames, s.desktopPreferences, s.archivedKeys, s.dialogs]);
  // 阻塞交互按会话分摊（ZCode：只渲染当前会话的 pendingInteractions）：
  // ask_user_question 内联在对话流；其余（工具审批等）保持弹窗；后台会话只亮侧栏胶囊。
  const sessionDialogs = s.dialogs.filter((d) => d.key === s.selectedKey);
  const askDialog = sessionDialogs.find((d) => isAskDialog(d)) ?? null;
  // 命令/工具权限审批 → 对话框上方内联选项卡（confirm 旧协议 + select 新协议）；其余扩展交互（select/input）保持居中弹窗。
  const approvalDialog = sessionDialogs.find((d) => d !== askDialog && isApprovalDialog(d) && (d.request.method === 'confirm' || d.request.method === 'select')) ?? null;
  const modalDialog = sessionDialogs.find((d) => d !== askDialog && d !== approvalDialog) ?? null;
  const messages = useMemo(
    () => sentConversationMessages(s.history?.branch ?? [], s.live[s.selectedKey ?? ''], s.toolProgress[s.selectedKey ?? ''], (s.sends ?? []).filter(send => send.key === s.selectedKey)),
    [s.history, s.live, s.toolProgress, s.selectedKey, s.sends],
  );
  // 自动化“立即运行”的乐观气泡：点击瞬间进对话，真实消息回显后自动让位。
  const launchPrompt = automationLaunchPrompt(s, messages.some(m => m.role === 'user'));
  const [subagentPanel,setSubagentPanel]=useState<{callId?:string}|null>(null);
  const [subagentSeen,setSubagentSeen]=useState(0);
  const parentRunning=Boolean(run&&['starting','running','stopping'].includes(run.status));
  // 兜底：任何入口（导航回放/启动恢复）没把 subagentDismissed 初始化时，直接读持久化偏好，
  // 防止已清空的子代理重进又出现。
  const dismissed = s.subagentDismissed ?? s.desktopPreferences?.subagentDismissed?.[s.selectedKey ?? ''] ?? [];
  const subagents=useMemo(()=>projectSubagents(messages,parentRunning,(s.recoveredSubagents??[]).filter(r=>!dismissed.includes(r.callId))).filter(c=>!dismissed.includes(c.callId)),[messages,parentRunning,s.recoveredSubagents,dismissed]);
  // 红色计数徽章：未查看的已结束子代理数量（completed/failed/interrupted/recovered）。
  const subagentUnseen=Math.max(0, subagents.filter(c=>['completed','failed','interrupted','recovered'].includes(c.status)).length - subagentSeen);
  // 计划查看器（复刻 ZCode plan-detail 侧板）：与会话绑定，切换会话时关闭。
  const [planOpen,setPlanOpen]=useState(false);
  // 内置终端（ZCode 侧板终端）：面板常挂载，切换会话不关闭。
  const [terminalOpen,setTerminalOpen]=useState(false);
  const [terminalStarted,setTerminalStarted]=useState(false);
  useEffect(()=>{if(terminalOpen)setTerminalStarted(true);},[terminalOpen]);
  useEffect(()=>{setSubagentPanel(null);setSubagentSeen(0);setPlanOpen(false);},[s.selectedKey]);
  // 文件面板与子代理面板共用右侧栏：文件面板变为打开时覆盖收起子代理面板，避免四栏并排过挤
  useEffect(()=>{ if (s.workbenchOpen) setSubagentPanel(p=>(p?null:p)); },[s.workbenchOpen]);
  const [planSnapshots,setPlanSnapshots]=useState<Record<string,string>>(()=>{try{return JSON.parse(localStorage.getItem('pi-plan-snapshots')||'{}') as Record<string,string>;}catch{return {};}});
  const livePlan=run?.accessMode==='plan'?planDocument(messages):null;
  useEffect(()=>{
    // ZCode 把 markdown 快照存进侧板 tab 兜底；这里按会话快照到 localStorage，
    // 执行模式 / 重启后仍能回看最后一次计划。计划模式下每次产出新文档即更新。
    const planKey=s.selectedKey;
    if(!livePlan||!planKey) return;
    setPlanSnapshots(prev=>{
      if(prev[planKey]===livePlan.markdown) return prev;
      const entries=Object.entries({...prev,[planKey]:livePlan.markdown});
      const next=Object.fromEntries(entries.slice(-50)) as Record<string,string>;
      try{localStorage.setItem('pi-plan-snapshots',JSON.stringify(next));}catch{/* 存储不可用时仅影响重启后的回看 */}
      return next;
    });
  },[livePlan,s.selectedKey]);
  const planDoc=livePlan??(s.selectedKey&&planSnapshots[s.selectedKey]?planFromMarkdown(planSnapshots[s.selectedKey]):null);
  // 计划审批时自动在右侧展开计划全文（计划内容长，对话框位置的卡片展示不全；对齐 ZCode PlanDetailSidePane）。
  // 审批通过后右侧面板保留展示计划快照+任务清单进度，用户可手动关闭；依赖布尔翻转，关闭后不会立即重弹。
  const planApprovalActive=run?.accessMode==='plan'&&run.status==='idle'&&run.planReady&&Boolean(planDoc);
  useEffect(()=>{ if (planApprovalActive) setPlanOpen(true); },[planApprovalActive]);
  const planChecklist=useMemo(()=>conversationPlan(messages),[messages]);
  const modelGroups = useMemo(() => run ? groupModels(run) : (s.catalog?.providers ?? []).map(p=>({provider:p.id,models:p.models.map(m=>({id:`${p.id}/${m.id}`,name:m.name || m.id}))})), [run,s.catalog]);
  const composerCwd = run?.cwd ?? s.sessions.find(session=>session.key===s.selectedKey)?.cwd ?? s.draftCwd;
  // ↑/↓ 发送历史：按 workspace 隔离、localStorage 持久化（ZCode 同款，最多 30 条）。
  const [promptHistory, setPromptHistory] = useState<string[]>(() => readPromptHistory(composerCwd ?? ''));
  useEffect(() => { setPromptHistory(readPromptHistory(composerCwd ?? '')); }, [composerCwd]);
  const onComposerSend = useCallback((text: string) => {
    // 只记录用户在输入框真正提交的 prompt（程序化 send 如计划批准语不进历史）。
    setPromptHistory(prev => {
      const next = appendPromptHistoryEntry(prev, text);
      if (next !== prev) persistPromptHistory(composerCwd ?? '', next);
      return next;
    });
    s.send(text);
  }, [composerCwd, s.send]);
  const draftModelId = s.draftModelId ?? (s.catalog?.defaultProvider && s.catalog?.defaultModel ? `${s.catalog.defaultProvider}/${s.catalog.defaultModel}` : '');
  const draftModel = s.catalog?.providers.flatMap(p=>p.models.map(m=>({...m,combinedId:`${p.id}/${m.id}`}))).find(m=>m.combinedId===draftModelId);
  const [filePreview, setFilePreview] = useState<ReturnType<typeof toolFilePreview>>(null);
  const [pluginTab, setPluginTab] = useState<'installed' | 'marketplace'>('installed');
  const [pluginTag, setPluginTag] = useState('all');
  const [, setFilePreviewVersion] = useState(0);
  const [sidebarWidth, setSidebarWidth, resetSidebarWidth] = usePanelWidth('pi.sidebarWidth', 366, 220, 520);
  const [workbenchWidth, setWorkbenchWidth, resetWorkbenchWidth] = usePanelWidth('pi.workbenchWidth', 415, 300, 700);
  // 右侧三个互叠的侧板（子代理/计划/终端）同样可拖宽，ZCode 侧板均带 col-resize。
  const [subagentWidth, setSubagentWidth, resetSubagentWidth] = usePanelWidth('pi.subagentWidth', 440, 300, 720);
  const [planWidth, setPlanWidth, resetPlanWidth] = usePanelWidth('pi.planWidth', 480, 320, 720);
  const [terminalHeight, setTerminalHeight, resetTerminalHeight] = usePanelWidth('pi.terminalHeight', 300, 160, 640);
  const previewRequest = useRef(0);
  useEffect(() => { previewRequest.current++; setFilePreview(null); }, [s.selectedKey]);
  // 切到插件市场 tab 时若列表为空则自动搜索一次（覆盖任何进入路径，不单靠 tab 点击回调）。
  useEffect(() => {
    if (s.view === 'plugins' && pluginTab === 'marketplace' && !s.market.length && !s.marketLoading && !s.marketQuery) {
      s.searchMarketplace('');
    }
  }, [s.view, pluginTab, s.market.length, s.marketLoading, s.marketQuery]);
  const openToolFile: NonNullable<import('../replica/contracts').ChatViewProps['onOpenToolFile']> = useCallback(part => {
    const preview = toolFilePreview(part);
    if (!preview) return;
    const request = ++previewRequest.current;
    setFilePreview(preview); setFilePreviewVersion(v=>v+1);
    if (preview.current && cwd) {
      const key = s.selectedKey;
      void window.localPi!.filePreview(cwd, preview.path).then(result=>{
        if(request !== previewRequest.current || usePiStore.getState().selectedKey !== key || !usePiStore.getState().workbenchOpen) return;
        const diff = parseUnifiedDiff(result.diff)[0];
        setFilePreview({...result, line:preview.line, diff:diff ? {...diff,path:result.path} : undefined, current:true});
        setFilePreviewVersion(v=>v+1);
        usePiStore.setState({workbenchOpen:true,workbenchTab:diff ? 'review' : 'files'});
      }).catch(error=>{
        if(request !== previewRequest.current || usePiStore.getState().selectedKey !== key || !usePiStore.getState().workbenchOpen) return;
        setFilePreview({path:preview.path,note:`无法预览文件：${String((error as Error).message || error)}`});
      });
    }
    usePiStore.setState({workbenchOpen:true,workbenchTab:preview.diff ? 'review' : 'files'});
  }, [cwd]);
  // 编辑并重发已发送消息（fork 截断回该条目 → 普通发送）。稳定回调避免击穿 TurnArticle 的 memo。
  const editUserMessage = useCallback((entryId: string, text: string) => {
    void usePiStore.getState().resendEdited(entryId, text);
  }, []);
  // 图片灯箱下载：主进程弹保存对话框写盘。
  const downloadImage = useCallback((dataUrl: string, name: string) => {
    window.localPi!.downloadImage(name, dataUrl).catch(() => usePiStore.setState({ error: '图片保存失败' }));
  }, []);
  const reviewDiffs = useMemo(() => (s.review ? reviewDiffEntries(s.review) : []), [s.review]);
  const runModels = run?.models ?? [];

  const composer = (
    <Composer
      draftText={s.draftText}
      onDraftChange={s.setDraftText}
      preparing={s.connecting || s.changingAccessMode || attachmentLoading}
      hasAttachments={s.contextItems.length > 0}
      onPaste={pasteAttachments}
      sessionActive={Boolean(s.selectedKey)}
      modelId={run?.model ? `${run.model.provider}/${run.model.id}` : draftModelId}
      modelGroups={modelGroups}
      reasoning="off"
      agentMode="agent"
      permissionMode="ask"
      slashCommands={[
        // 内置命令：get_commands 只回扩展命令/模板/skills，手动补上 Desktop 已拦截路由的内置项。
        ...(run ? [{ name: '/compact', description: s.lang === 'zh' ? '手动压缩会话上下文' : 'Manually compact the session context' }] : []),
        ...(run?.commands ?? []).map((c) => ({ name: `/${c.name}`, description: c.description ?? '' })),
      ]}
      files={[]}
      running={Boolean(run && ['running', 'starting', 'stopping'].includes(run.status))}
      queued={run?.pending ?? 0}
      queue={run?.queue}
      onQueueNow={(index) => s.queueEdit({ type: 'now', index })}
      onQueueEdit={(index, text) => s.queueEdit({ type: 'edit', index, text })}
      onQueueRecall={(index) => s.queueRecall(index)}
      onQueueRemove={(index) => s.queueEdit({ type: 'remove', index })}
      demo={false}
      labels={t.composer}
      modelDisabled={s.connecting}
      pendingModelId={run?.pendingModel ? `${run.pendingModel.provider}/${run.pendingModel.id}` : undefined}
      headerSlot={<ProjectHeader cwd={composerCwd} locked={!!s.selectedKey || s.connecting} onChoose={s.chooseWorkspace} projects={sidebar.projects.map(p=>({path:p.path,name:p.name}))} onSelect={path=>usePiStore.setState({draftCwd:path})} />}
      addSlot={<ComposerAdd cwd={composerCwd} disabled={s.connecting} onAdd={s.addContext} />}
      contextSlot={<><ContextChips items={s.contextItems} remove={s.removeContext} />{attachmentLoading && <div className="pi-attachment-loading" role="status">正在读取附件…</div>}</>}
      reasoningSlot={<ThinkingMenu value={run?.thinkingLevel ?? s.desktopPreferences?.defaultThinkingLevel ?? 'off'} levels={run ? (run.thinkingLevels ?? []) : draftModel?.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const : []} disabled={s.connecting} pending={run?.pendingThinking} onChange={s.pickThinking} />}
      voiceSlot={appendTranscript =>
        <VoiceInputButton
          key={`${s.selectedKey ?? 'draft'}:${composerCwd ?? ''}`}
          labels={t.composer}
          zh={s.lang === 'zh'}
          disabled={s.connecting}
          onTranscript={appendTranscript}
          onError={message => s.notify({ kind: 'error', title: message, time: '刚刚' })}
          onNotConfigured={() => {
            s.notify({ kind: 'info', title: t.composer.voiceNotConfigured ?? 'Voice input is not configured', time: '刚刚' });
            s.openSettings('voice');
          }}
        />
      }
      leftSlot={
        <>
          <AccessModeMenu value={run?.accessMode ?? s.draftAccessMode ?? s.desktopPreferences?.sessionAccessModes?.[s.selectedKey ?? ''] ?? s.desktopPreferences?.permission ?? 'ask'} disabled={s.connecting} changing={s.changingAccessMode} zh={s.lang === 'zh'} onChange={s.setAccessMode} />
          {!run && s.history && s.history.leaves.length > 1 && <select className="pi-history-branch" aria-label={s.lang === 'zh' ? '对话历史分支' : 'History branch'} title={s.lang === 'zh' ? '会话消息树在此分叉过（重试/编辑/分叉会产生多个分支），非 git 分支' : 'The session message tree forked here (retry/edit/fork) — not a git branch'} value={s.leaf ?? s.history.leafId ?? ''} onChange={e => usePiStore.setState({leaf:e.target.value})}>{s.history.leaves.map((id, i) => <option key={id} value={id}>{`${s.lang === 'zh' ? '对话分支' : 'Branch'} ${i + 1}`}</option>)}</select>}
          {s.connecting && <span role="status">{s.lang === 'zh' ? '正在准备任务…' : 'Preparing task…'}</span>}
        </>
      }
      statusSlot={run ? <ContextUsageChip key={`${run.key}:${run.generation}`} usage={run.contextUsage} model={run.model ? `${run.model.provider} / ${run.model.name || run.model.id}` : undefined} zh={s.lang === 'zh'} compact /> : undefined}
      onSend={onComposerSend}
      promptHistory={promptHistory}
      onStop={s.stop}
      onPickModel={s.pickModel}
      onPickReasoning={() => undefined}
      onPickAgentMode={() => undefined}
      onPickPermission={() => undefined}
      hideReasoning
    />
  );

  const searchItems: SearchItem[] = useMemo(() => {
    const sessions: SearchItem[] = s.sessions.filter(sess=>!s.archivedKeys.includes(sess.key)&&!s.desktopPreferences?.hiddenProjects?.includes(sess.cwd)).map((sess) => ({
      id: `sess-${sess.key}`,
      kind: 'session',
      title: sess.name,
      source: sess.owned ? 'Desktop' : pathLabel(sess.cwd),
    }));
    const commands: SearchItem[] = (run?.commands ?? []).map((c) => ({
      id: `cmd-${c.name}`,
      kind: 'command',
      title: `/${c.name}`,
      source: s.lang === 'zh' ? '命令' : 'Command',
    }));
    const pages: SearchItem[] = [
      { id: 'pg-plugins', kind: 'page', title: t.plugins.title, source: s.lang === 'zh' ? '页面' : 'Page' },
      { id: 'pg-settings', kind: 'setting', title: t.settings.general, source: s.lang === 'zh' ? '设置' : 'Setting' },
    ];
    const q = s.searchQuery.trim().toLowerCase();
    const all = [...sessions, ...commands, ...pages];
    return q ? all.filter((i) => i.title.toLowerCase().includes(q)) : all;
  }, [s.sessions, s.archivedKeys, s.desktopPreferences, s.searchQuery, run, t, s.lang]);

  const onSelectSearch = (item: SearchItem) => {
    s.setSearchOpen(false);
    if (item.kind === 'command') {
      s.setDraftText(`${item.title} `);
      s.navigate('chat');
    } else if (item.id === 'pg-plugins') {
      s.navigate('plugins');
    } else if (item.id === 'pg-settings') {
      s.openSettings('general');
    } else if (item.id.startsWith('sess-')) {
      s.selectSession(item.id.slice(5));
    }
  };

  if (!window.localPi) {
    return (
      <div className={`${rootClass} pi-unavailable`} style={{ height: '100vh' }}>
        <div className="pi-unavailable__card">
          <div className="pi-unavailable__title">需要桌面环境</div>
          <p>此页面不会使用假数据替代本地 pi。请使用以下命令打开桌面应用：</p>
          <code>pnpm build &amp;&amp; pnpm start</code>
        </div>
      </div>
    );
  }

  const generalSections: SettingsSectionData[] = [
    {
      title: t.settings.appearance,
      rows: [
        { id: 'theme', title: t.settings.theme, description: t.settings.themeDesc, control: { kind: 'select', value: s.theme === 'dark' ? 'Dark' : 'Light', options: ['Light', 'Dark'] } },
        { id: 'language', title: t.settings.language, description: t.settings.languageDesc, control: { kind: 'select', value: s.lang === 'zh' ? '中文' : 'English', options: ['English', '中文'] } },
        { id: 'font', title: t.settings.font, description: t.settings.fontDesc, control: { kind: 'select', value: s.font ?? 'System default', options: ['System default', 'Serif', 'Mono'] } },
        { id: 'fontsize', title: t.settings.fontSize, description: t.settings.fontSizeDesc, control: { kind: 'slider', value: s.fontScale, min: 85, max: 125, suffix: '%', options: ['Tall', 'Grande', 'Venti', 'Trenta'] } },
      ],
    },
    {
      title: t.settings.network,
      rows: [
        { id: 'proxy-static', title: t.settings.proxy, description: t.settings.proxyDesc, control: { kind: 'static', text: s.lang === 'zh' ? '跟随系统' : 'System' } },
      ],
    },
    {
      // AI 配置并入通用页（原独立「AI」设置页已移除）
      title: s.lang === 'zh' ? 'AI 默认行为' : 'AI defaults',
      rows: [
        { id: 'ai-thinking', title: s.lang === 'zh' ? '默认推理级别' : 'Default thinking level', description: s.lang === 'zh' ? '写入 pi 全局 settings.json，新建或重载会话后生效' : 'Saved to pi settings.json; applies to new or reloaded sessions', control: { kind: 'select', value: s.aiSettings?.defaultThinkingLevel ?? 'high', options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] } },
        { id: 'ai-compact', title: s.lang === 'zh' ? '自动压缩上下文' : 'Auto-compact context', control: { kind: 'select', value: s.aiSettings?.autoCompact === false ? (s.lang === 'zh' ? '关闭' : 'Off') : (s.lang === 'zh' ? '开启' : 'On'), options: s.lang === 'zh' ? ['开启', '关闭'] : ['On', 'Off'] } },
        { id: 'ai-retry', title: s.lang === 'zh' ? '自动重试可恢复错误' : 'Auto-retry recoverable errors', control: { kind: 'select', value: s.aiSettings?.retry === false ? (s.lang === 'zh' ? '关闭' : 'Off') : (s.lang === 'zh' ? '开启' : 'On'), options: s.lang === 'zh' ? ['开启', '关闭'] : ['On', 'Off'] } },
      ],
    },
    {
      title: s.lang === 'zh' ? 'Desktop 执行偏好' : 'Desktop execution',
      rows: [
        { id: 'behavior', title: s.lang === 'zh' ? '运行中输入' : 'Input while running', description: s.lang === 'zh' ? '运行中再次发送时按此策略处理（排队追问 / 调整当前任务）' : 'How a follow-up is handled while a task runs', control: { kind: 'select', value: s.behavior === 'steer' ? (s.lang === 'zh' ? '调整当前任务' : 'Steer current task') : (s.lang === 'zh' ? '排队追问' : 'Queue follow-up'), options: s.lang === 'zh' ? ['排队追问', '调整当前任务'] : ['Queue follow-up', 'Steer current task'] } },
        { id: 'permission', title: s.lang === 'zh' ? '新任务默认访问模式' : 'Default access mode', description: s.lang === 'zh' ? '新任务的默认值，当前任务可在输入框切换' : 'Default for new tasks; switchable per task in the composer', control: { kind: 'select', value: { plan: s.lang === 'zh' ? '计划模式' : 'Plan', ask: s.lang === 'zh' ? '变更前确认' : 'Confirm changes', autoEdit: s.lang === 'zh' ? '自动编辑' : 'Auto edit', fullAccess: s.lang === 'zh' ? '完全访问' : 'Full access' }[s.desktopPreferences?.permission ?? 'ask'], options: s.lang === 'zh' ? ['计划模式', '变更前确认', '自动编辑', '完全访问'] : ['Plan', 'Confirm changes', 'Auto edit', 'Full access'] } },
      ],
    },
  ];

  const fontFamily = s.font === 'Serif' ? 'Georgia, "Songti SC", serif' : s.font === 'Mono' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined;

  const showTopBar = s.view === 'home' || s.view === 'chat';

  // 模型配置：供应商表单状态 + 真实保存/编辑/删除（写入 pi 的 models.json）。
  const providerSaving = useRef(false);
  const [loginProvider,setLoginProvider]=useState<{id:string;name:string}|null>(null);
  const [providerForm, setProviderForm] = useState<import("../replica/contracts").ProviderFormState>({ saving:false, open: false, editingId: null as string | null, name: '', baseUrl: '', apiKey: '', modelLine: '', error: undefined as string | undefined });
  const catalogProviders: ProviderCardData[] = (s.catalog?.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    baseUrl: p.baseUrl ?? '',
    modelCount: p.models.length,
    isDefault: s.catalog?.defaultProvider === p.id,
    enabled: true,
    source: p.source, auth:p.auth, loginAvailable:p.loginAvailable,
    models: p.models.map((m) => ({ ...m })),
  }));
  const parseModelLine = (line: string) => line.split('\n').flatMap((raw) => {
    const text = raw.trim(); if (!text) return [];
    const eq = text.indexOf('=');
    if (eq > 0) { const name = text.slice(0, eq).trim(), id = text.slice(eq + 1).trim(); return id ? [{ id, name: name || undefined }] : []; }
    return [{ id: text, name: undefined }];
  });
  const formatModelLine = (models: Array<{ id: string; name?: string }>) => models.map((m) => (m.name && m.name !== m.id ? `${m.name} = ${m.id}` : m.id)).join('\n');
  const editProvider = useCallback((id: string) => {
    const p = s.catalog?.providers.find((x) => x.id === id);
    if (!p) return;
    setProviderForm({ saving:false, open: true, editingId: id, name: p.name || p.id, baseUrl: p.baseUrl ?? '', apiKey: '', modelLine: formatModelLine(p.models), models: p.models.map(m=>({...m})), error: undefined });
  }, [s.catalog]);
  const saveProvider = useCallback(() => {
    if(providerSaving.current) return;
    const draft = providerForm;
    const models = draft.models ?? parseModelLine(draft.modelLine);
    if (!draft.name.trim()) { setProviderForm({ ...draft, error: '请填写名称。' }); return; }
    if (!models.length) { setProviderForm({ ...draft, error: '至少需要一条模型。' }); return; }
    const id = draft.editingId ?? (draft.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `custom-${Date.now()}`);
    providerSaving.current=true;
    setProviderForm(current=>({...current,saving:true,error:undefined}));
    void window.localPi!.modelProviderSave({ id, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), models })
      .then(() => { setProviderForm({ saving:false, open: false, editingId: null, name: '', baseUrl: '', apiKey: '', modelLine: '', error: undefined }); return s.loadCatalog(); })
      .then(() => s.notify({ kind: 'success', title: '提供商已保存', body: '已写入 pi 的 models.json；新建会话生效。', time: '刚刚' }))
      .catch((e) => setProviderForm(current => ({ ...current, error: String((e as Error).message || e) })))
      .finally(()=>{providerSaving.current=false;setProviderForm(current=>({...current,saving:false}));});
  }, [providerForm, s]);
  const deleteProvider = useCallback((id: string) => {
    const p = s.catalog?.providers.find((x) => x.id === id);
    if (!window.confirm(`删除提供商 ${p?.name || id}？该操作会从 pi 的 models.json 移除其配置。`)) return;
    void window.localPi!.modelProviderRemove(id).then(() => s.loadCatalog()).catch((e) => s.notify({ kind: 'error', title: String((e as Error).message || e), time: '刚刚' }));
  }, [s]);
  const makeDefault = useCallback((id: string) => {
    const p = s.catalog?.providers.find((x) => x.id === id);
    const model = p?.models[0]?.id;
    if (!model) { s.notify({ kind: 'error', title: '该供应商没有可用模型', time: '刚刚' }); return; }
    void window.localPi!.modelDefaultSave({ provider: id, model }).then(() => s.loadCatalog()).catch((e) => s.notify({ kind: 'error', title: String((e as Error).message || e), time: '刚刚' }));
  }, [s]);

  return (
    <SubagentNavigation.Provider value={callId=>{setSubagentPanel({callId});usePiStore.setState({workbenchOpen:false});}}>
    <div
      className={rootClass}
      style={{ height: '100vh', fontSize: `${s.fontScale}%`, ...(fontFamily ? { fontFamily } : {}), '--pi-sidebar-width': `${sidebarWidth}px`, '--pi-workbench-width': `${workbenchWidth}px`, '--pi-subagent-width': `${subagentWidth}px`, '--pi-plan-width': `${planWidth}px`, '--pi-terminal-height': `${terminalHeight}px` } as React.CSSProperties}
      data-pi-ready={s.env ? 'true' : undefined}
    >
      {loginProvider&&<AccountLoginDialog provider={loginProvider} onClose={()=>setLoginProvider(null)} onDone={s.loadCatalog}/>}
      {s.view === 'settings' && (
        <div className="pi-settings-wrap" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--pi-bg, #fff)' }}>
          {isMac && <div className="pi-dragstrip" aria-hidden="true" />}
        {s.error && <div role="alert" className="pi-banner pi-banner--error"><span>{s.error}</span><button aria-label="关闭错误" onClick={s.dismissError}>×</button></div>}
        <SettingsPage
          page={s.settingsPage as SettingsNavId}
          query={s.searchQuery}
          theme={s.theme}
          sections={generalSections}
          providers={catalogProviders}
          providerForm={providerForm}
          defaultModelLabel={
            s.catalog?.defaultModel
              ? `${s.catalog.defaultModel}${s.catalog.defaultProvider ? ` · ${s.catalog.defaultProvider}` : ''}`
              : run?.model
                ? `${run.model.name} · ${run.model.provider}`
                : null
          }
          vendorEmpty={t.settings.noVendor}
          catalogInfo={`${runModels.length} models available from pi`}
          demo={false}
          labels={t.settings}
          onBack={s.backToApp}
          onSearch={s.setSearchQuery}
          onSelectPage={s.openSettings}
          onRowControl={(rowId, value) => {
            if (rowId === 'theme') s.setTheme(value === 'Dark' ? 'dark' : 'light');
            else if (rowId === 'language') s.setLang(value === '中文' ? 'zh' : 'en');
            else if (rowId === 'fontsize') s.setFontScale(typeof value === 'number' ? value : 100);
            else if (rowId === 'font') s.setFont(String(value));
            else if (rowId === 'behavior') {
              const behavior = (value === '调整当前任务' || value === 'Steer current task') ? 'steer' : 'followUp';
              const prefs = usePiStore.getState().desktopPreferences;
              const merged = { behavior, permission: 'ask' as AccessMode, shortcuts: DEFAULT_SHORTCUTS, projects: [], ...prefs };
              usePiStore.setState({ behavior, desktopPreferences: { ...merged, behavior } });
              void window.localPi!.saveDesktopSettings({ behavior }).catch(e => s.notify({ kind: 'error', title: String((e as Error).message || e), time: '刚刚' }));
            } else if (rowId === 'permission') {
              const map: Record<string, AccessMode> = { 计划模式: 'plan', Plan: 'plan', 变更前确认: 'ask', 'Confirm changes': 'ask', 自动编辑: 'autoEdit', 'Auto edit': 'autoEdit', 完全访问: 'fullAccess', 'Full access': 'fullAccess' };
              const permission = map[String(value)];
              if (permission) {
                const prefs = usePiStore.getState().desktopPreferences;
                const merged = { behavior: 'followUp' as const, permission, shortcuts: DEFAULT_SHORTCUTS, projects: [], ...prefs };
                usePiStore.setState({ desktopPreferences: { ...merged, permission } });
                void window.localPi!.saveDesktopSettings({ permission }).catch(e => s.notify({ kind: 'error', title: String((e as Error).message || e), time: '刚刚' }));
              }
            } else if (rowId === 'ai-thinking' || rowId === 'ai-compact' || rowId === 'ai-retry') {
              const current = usePiStore.getState().aiSettings;
              if (!current) return;
              const next = {
                ...current,
                ...(rowId === 'ai-thinking' ? { defaultThinkingLevel: String(value) } : {}),
                ...(rowId === 'ai-compact' ? { autoCompact: value === '开启' || value === 'On' } : {}),
                ...(rowId === 'ai-retry' ? { retry: value === '开启' || value === 'On' } : {}),
              };
              usePiStore.setState({ aiSettings: next });
              void window.localPi!.saveAiSettings(next)
                .then(() => s.notify({ kind: 'success', title: s.lang === 'zh' ? '已写入 pi settings.json；新建或重载会话生效' : 'Saved to pi settings.json', time: '刚刚' }))
                .catch(e => { usePiStore.setState({ aiSettings: current }); s.notify({ kind: 'error', title: String((e as Error).message || e), time: '刚刚' }); });
            }
          }}
          onSetProviderForm={(patch) => setProviderForm(current => ({ ...current, ...patch }))}
          catalogWarning={s.catalog?.warning}
          onLoginProvider={id=>{const p=s.catalog?.providers.find(p=>p.id===id);if(p)setLoginProvider({id,name:p.name||id});}}
          onSelectDefaultModel={(provider,model)=>{void window.localPi!.modelDefaultSave({provider,model}).then(()=>s.loadCatalog()).catch(e=>s.notify({kind:'error',title:String(e.message||e),time:'刚刚'}));}}
          onSaveProvider={saveProvider}
          onSaveProviderModel={async (providerId,model,originalId)=>{
            const catalog=await window.localPi!.modelCatalog();
            const provider=catalog.providers.find(p=>p.id===providerId);
            if(!provider||provider.source!=='models.json')throw new Error('提供商不存在或不可编辑，请刷新后重试。');
            if(originalId&&!provider.models.some(m=>m.id===originalId))throw new Error('模型已被移除，请刷新后重试。');
            if(provider.models.some(m=>m.id===model.id&&m.id!==originalId))throw new Error('该模型 ID 已存在。');
            const models=originalId?provider.models.map(m=>m.id===originalId?model:m):[...provider.models,model];
            await window.localPi!.modelProviderSave({...provider,baseUrl:provider.baseUrl??'',models});
            await s.loadCatalog();
            s.notify({kind:'success',title:'模型配置已保存',body:'已写入 pi 的 models.json；新建会话生效。',time:'刚刚'});
          }}
          onEditProvider={editProvider}
          onDeleteProvider={deleteProvider}
          onToggleProvider={() => s.notify({ kind: 'info', title: s.lang === 'zh' ? 'pi 提供商默认启用' : 'pi providers are always enabled', time: '刚刚' })}
          onMakeDefault={makeDefault}
          onRefreshCatalog={s.loadCatalog}
          infoExtra={<ConnectionPane />}
          pageContent={!['general', 'models', 'info'].includes(s.settingsPage) ? <SettingsFeatures key={s.settingsPage} page={s.settingsPage} cwd={cwd} query={s.searchQuery} loadedExtensionPaths={run ? [...new Set((run.commands ?? []).filter(c => c.source === 'extension' && c.path).map(c => c.path as string))] : []} workspace={<RemotePane />} /> : undefined}
        />
        </div>
      )}
      {(<>
          <Sidebar
            projects={sidebar.projects}
            projectMenu={project=><ProjectActions project={project} />}
            temporarySessions={sidebar.temporary}
            activeSessionId={s.view === 'chat' || s.view === 'home' ? s.selectedKey : null}
            collapsed={s.sidebarCollapsed}
            version={`pi ${s.env?.version ?? '未发现'}`}
            labels={t.sidebar}
            onSelectSession={s.selectSession}
            onArchiveSession={id=>void s.setSessionArchived(id,true)}
            onNewSession={s.startNewSession}
            onAddProject={s.addProject}
            addingProject={s.addingProject}
            onOpenSearch={() => s.setSearchOpen(true)}
            searchOpen={s.searchOpen}
            shortcutHints={{ newSession: (s.desktopPreferences?.shortcuts.newSession ?? 'Mod+Shift+N').replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace('Shift', '⇧').replaceAll('+', ' '), search: (s.desktopPreferences?.shortcuts.search ?? 'Mod+K').replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace('Shift', '⇧').replaceAll('+', ' ') }}
            onToggleProject={s.toggleProject}
            onToggleCollapse={s.toggleSidebar}
            onOpenSettings={() => s.openSettings('general')}
            onOpenAutomations={()=>s.navigate('automations')}
            onOpenPlugins={() => s.navigate('plugins')}
            onToggleNotifications={s.toggleNotifications}
            onRenameSession={(id, name) => s.renameSession(id, name)}
            notificationsCount={s.notifications.filter((n) => !n.read).length}
            activeOverlay={s.view === 'automations' ? 'automations' : s.view === 'plugins' ? 'plugins' : s.notificationsOpen ? 'notifications' : null}
            onNavBack={s.navBack}
            onNavForward={s.navForward}
            canNavBack={canNavBack(s)}
            canNavForward={canNavForward(s)}
            navLabels={{ back: s.lang === 'zh' ? '后退' : 'Back', forward: s.lang === 'zh' ? '前进' : 'Forward' }}
          />
          {!s.sidebarCollapsed && <ResizeHandle side="left" width={sidebarWidth} min={220} max={520} onChange={setSidebarWidth} onReset={resetSidebarWidth} label="项目侧栏宽度" />}
          <div className="pireplica__main" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            {showTopBar && (
              <TopBar
                title={title || 'PI Desktop'}
                labels={t.topbar}
                onNewSession={s.startNewSession}
                onOpenSearch={() => s.setSearchOpen(true)}
                onToggleWorkbench={s.toggleWorkbench}
                workbenchOpen={s.workbenchOpen}
                onToggleTerminal={()=>setTerminalOpen(value=>!value)}
                terminalOpen={terminalOpen}
                openWith={<OpenWithMenu cwd={cwd ?? s.draftCwd} lang={s.lang} />}
              />
            )}
            {s.error && (
              <div className="pi-banner pi-banner--error" role="alert">
                <span>{s.error}</span>
                <button aria-label="关闭错误" onClick={s.dismissError}>×</button>
              </div>
            )}
            {s.notice && (
              <div className="pi-banner" role="status">
                <span>{s.notice}</span>
                <button aria-label="关闭提示" onClick={s.dismissNotice}>×</button>
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
              {s.view === 'home' && (() => {
                const hour = new Date().getHours();
                const greeting = s.lang === 'zh'
                  ? `${hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'}，今天辛苦啦`
                  : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
                const presets = s.desktopPreferences?.agentPresets?.length ? s.desktopPreferences.agentPresets : DEFAULT_AGENT_PRESETS;
                return (
                  <HomeView
                    greeting={greeting}
                    composer={composer}
                    presets={presets.map((p) => ({ id: p.id, label: p.label, icon: p.icon as import('../replica/Icons').IconName }))}
                    onPickPreset={(id) => {
                      const preset = presets.find((p) => p.id === id);
                      if (preset) s.setDraftText(preset.skill ? `使用 ${preset.skill} 技能。${preset.prompt}` : preset.prompt);
                    }}
                  />
                );
              })()}
              {/* 非 home 视图（设置/插件/自动化）期间保留 chat 挂载（display:none）：返回应用时
                  ChatView 不重挂载，否则大会话（60 轮 + 导航刻度）整体重挂会造成秒级长帧 */}
              {s.view !== 'home' && (
                <div style={{ flex: 1, minWidth: 0, display: s.view === 'chat' ? 'flex' : 'none', flexDirection: 'column' }}>
                  {run?.accessMode === 'plan' && run.status === 'idle' && run.planReady && planDoc && <PlanCard doc={planDoc} lang={s.lang} onViewPlan={()=>setPlanOpen(true)} />}
                  {run?.accessMode === 'plan' && run.status === 'idle' && run.planReady && <PlanApprovalCard lang={s.lang} executing={Boolean(s.changingAccessMode)} onApprove={s.executePlan} onDecline={s.declinePlan} />}
                  <ChatView
                    messages={messages}
                    runTiming={run?.timing}
                    running={Boolean(run && ['running', 'stopping'].includes(run.status))}
                    queued={run?.pending ?? 0}
                    scrollRequest={(s.sends ?? []).filter(send => send.key === s.selectedKey).at(-1)?.id}
                    sending={(s.sends ?? []).some(send => send.key === s.selectedKey && !send.confirmedId) || run?.status === 'starting' || Boolean(launchPrompt)}
                    sendingText={launchPrompt}
                    steeringText={s.pendingSteer?.[s.selectedKey ?? '']?.text}
                    steeringImages={s.pendingSteer?.[s.selectedKey ?? '']?.images}
                    sendingAt={launchPrompt ? s.automationLaunch!.startedAt : s.sentAt?.key === s.selectedKey ? s.sentAt.at : undefined}
                    retrying={s.selectedKey ? s.retrying?.[s.selectedKey] ?? undefined : undefined}
                    queue={run?.queue?.filter(q => !(q.behavior === 'steer' && q.text === s.pendingSteer?.[s.selectedKey ?? '']?.text))}
                    demo={false}
                    labels={t.chat}
                    onOpenToolFile={openToolFile}
                    onJumpToMessage={noop}
                    onEditUserMessage={parentRunning ? undefined : editUserMessage}
                    onDownloadImage={downloadImage}
                  />
                  {/* ask_user_question 与命令/工具权限审批内联在会话对话流（ZCode bottom dock），非全局弹窗 */}
                  {askDialog && <InlineAskCard key={`${askDialog.generation}:${askDialog.request.id}`} dialog={askDialog} />}
                  {approvalDialog && <InlineApprovalCard key={`${approvalDialog.generation}:${approvalDialog.request.id}`} dialog={approvalDialog} />}
                  <div style={{ padding: run ? '0 24px 20px' : '0 24px 20px' }}>{composer}</div>
                </div>
              )}
              {s.view === 'automations' && <AutomationsPage projects={[...new Set([...(s.desktopPreferences?.projects.map(p=>p.path)||[]),...s.sessions.map(session=>session.cwd)])]} models={(s.catalog?.providers||[]).flatMap(p=>p.models.map(m=>({id:`${p.id}/${m.id}`,name:`${p.id} / ${m.name||m.id}`})))} onOpenSession={key=>s.selectSession(key)} onRunTask={task=>s.runAutomationNow(task)} />}
              {s.view === 'plugins' && (
                <PluginsPage
                  tab={pluginTab}
                  installed={[
                    // 已装 npm 包（pi install 那套）；未注册的给「注册」入口
                    ...s.piPackages.map((p): PluginRowData => ({
                      id: `pkg:${p.name}`,
                      name: p.name.replace(/^@[^/]+\//, '').replace(/^pi-/, ''),
                      packageId: 'npm 包',
                      version: p.version,
                      status: p.registered ? 'active' : 'off',
                      scope: 'everywhere',
                      badge: p.registered ? undefined : (s.lang === 'zh' ? '未注册' : 'Unregistered'),
                      primaryAction: p.registered ? undefined : (s.lang === 'zh' ? '注册' : 'Register'),
                      details: [p.description, `${s.lang === 'zh' ? '来源' : 'Source'}：${p.spec}`, p.path].filter(Boolean),
                    })),
                    ...resourcesToPluginRows(s.resources.filter((r) => r.kind === 'extensions')),
                  ]}
                  marketplace={s.market.map((pkg) => {
                    const installedPkg = s.piPackages.find((p) => p.name === pkg.name);
                    return {
                      id: pkg.name,
                      name: pkg.name.replace(/^@[^/]+\//, '').replace(/^pi-/, ''),
                      verified: false,
                      publisher: pkg.publisher,
                      version: pkg.version,
                      installs: 0,
                      description: pkg.description || pkg.name,
                      permissions: [],
                      installedVersion: installedPkg?.version || undefined,
                      updateAvailable: Boolean(installedPkg && installedPkg.version !== pkg.version),
                      published: true,
                      tags: pkg.keywords.filter((k) => !['pi', 'pi-package', 'pi-coding-agent'].includes(k)).slice(0, 3),
                      covers: s.covers[pkg.name],
                    };
                  })}
                  search={pluginTab === 'marketplace' ? s.marketQuery : s.searchQuery}
                  marketplaceSource="npm"
                  marketplaceSources={['npm']}
                  tag={pluginTag}
                  tags={[]}
                  updatesReady={0}
                  demo={false}
                  labels={{ ...t.plugins, searchInstalled: s.lang === 'zh' ? '过滤已装资源…' : 'Filter installed…', searchMarketplace: s.lang === 'zh' ? '搜索 npm 上的 pi 包…' : 'Search pi packages on npm…' }}
                  onSelectTab={(tab) => { setPluginTab(tab); if (tab === 'marketplace' && !s.market.length && !s.marketLoading && !s.marketQuery) s.searchMarketplace(''); }}
                  onSearch={(q) => { if (pluginTab === 'marketplace') s.searchMarketplace(q); else usePiStore.setState({ searchQuery: q }); }}
                  onSelectTag={setPluginTag}
                  onSelectSource={() => undefined}
                  onTogglePlugin={(id) => {
                    const pkg = s.piPackages.find((p) => `pkg:${p.name}` === id);
                    if (pkg && !pkg.registered) { s.registerPackage(pkg.spec); return; }
                    s.notify({ kind: 'info', title: s.lang === 'zh' ? '资源的启停请在 pi 配置中管理' : 'Manage resources in the pi configuration', time: '刚刚' });
                  }}
                  onUpdatePlugin={(id) => { const pkg = s.market.find((m) => m.name === id); if (pkg) s.installPackage(`npm:${pkg.name}`); }}
                  onInstallPlugin={(id) => { const pkg = s.market.find((m) => m.name === id); if (pkg) s.installPackage(`npm:${pkg.name}`); }}
                  onOpenMarketplace={() => setPluginTab('marketplace')}
                  onRefreshMarketplace={() => { if (pluginTab === 'marketplace') s.searchMarketplace(s.marketQuery); else { s.loadPackages(); s.scanResources(); } }}
                  onApplyUpdates={() => undefined}
                />
              )}
              {s.view === 'chat' && subagents.length>0 && !subagentPanel && <button className="pi-btn pi-btn--outline pi-subagents-entry" onClick={()=>{setSubagentPanel({});setSubagentSeen(subagents.filter(c=>['completed','failed','interrupted','recovered'].includes(c.status)).length);usePiStore.setState({workbenchOpen:false});}}>子代理 · {subagents.length}{subagentUnseen>0 && <span className="pi-subagents-badge">{subagentUnseen}</span>}</button>}
              {subagentPanel && s.view==='chat' && <ResizeHandle side="right" width={subagentWidth} min={300} max={720} onChange={setSubagentWidth} onReset={resetSubagentWidth} label="子代理面板宽度" />}
              {subagentPanel && s.view==='chat' && <SubagentPanel key={`${s.selectedKey}:${subagentPanel.callId||''}`} children={subagents} initialCall={subagentPanel.callId} parentRunning={parentRunning} onClose={()=>setSubagentPanel(null)} onStop={s.stop}/>}
              {s.view==='chat' && planOpen && <ResizeHandle side="right" width={planWidth} min={320} max={720} onChange={setPlanWidth} onReset={resetPlanWidth} label="计划面板宽度" />}
              {s.view==='chat' && planOpen && <PlanViewer key={s.selectedKey||'draft'} doc={planDoc} checklist={planChecklist} lang={s.lang} running={Boolean(run&&['running','stopping'].includes(run.status))} planMode={run?.accessMode==='plan'} onClose={()=>setPlanOpen(false)} onExecute={s.executePlan}/>}
              {s.view === 'chat' && !s.workbenchOpen && !subagentPanel && !planOpen && <ConversationStatusPanel key={s.selectedKey || 'draft'} cwd={cwd} messages={messages} running={Boolean(run && ['running','stopping'].includes(run.status))} stats={run?.stats} onReview={()=>{setFilePreview(null);s.selectWorkbenchTab('review');}} onRequest={text=>{s.setDraftText(s.draftText ? `${s.draftText}\n\n${text}` : text);}} onOpenPlan={()=>setPlanOpen(true)} planAvailable={Boolean(planDoc||planChecklist.length)} />}
              {s.workbenchOpen && (s.view === 'chat' || s.view === 'home') && <ResizeHandle side="right" width={workbenchWidth} min={300} max={700} onChange={setWorkbenchWidth} onReset={resetWorkbenchWidth} label="工作面板宽度" />}
              <WorkbenchPanel
                cwd={cwd}
                open={s.workbenchOpen && (s.view === 'chat' || s.view === 'home')}
                tab={s.workbenchTab}
                // 不设 key：重挂载会销毁浏览器 webview；预览文件的展开重置由 WorkbenchPanel 内部比对 selectedFile 完成。
                browserPanel={<BrowserPanel labels={t.browser} />}
                diffs={filePreview ? (filePreview.diff ? [filePreview.diff] : []) : reviewDiffs}
                files={[
                  // review 里的编辑文件都可点选查看完整内容
                  ...reviewDiffs.map((d) => ({ path: d.path, excerpt: [] as string[] })),
                  ...(filePreview?.content !== undefined ? [{ path: filePreview.path, excerpt: filePreview.content.split('\n') }] : []),
                ].filter((f, i, arr) => arr.findIndex((x) => x.path === f.path) === i)}
                selectedFile={filePreview?.path ?? null}
                fileLine={filePreview?.line}
                note={filePreview?.note}
                demo={false}
                labels={t.workbench}
                onToggle={s.toggleWorkbench}
                onSelectTab={tab=>{if(filePreview){usePiStore.setState({workbenchTab:tab});}else s.selectWorkbenchTab(tab);}}
                onSelectFile={(filePath) => {
                  if (!filePath || !cwd) return;
                  const request = ++previewRequest.current;
                  setFilePreview({ path: filePath, note: '正在读取…' });
                  setFilePreviewVersion((v) => v + 1);
                  void window.localPi!.filePreview(cwd, filePath).then((result) => {
                    if (request !== previewRequest.current) return;
                    const diff = parseUnifiedDiff(result.diff)[0];
                    setFilePreview({ ...result, diff: diff ? { ...diff, path: result.path } : undefined, current: true });
                    setFilePreviewVersion((v) => v + 1);
                    usePiStore.setState({ workbenchOpen: true, workbenchTab: 'files' });
                  }).catch((error) => {
                    if (request !== previewRequest.current) return;
                    setFilePreview({ path: filePath, note: `无法预览文件：${String((error as Error).message || error)}` });
                  });
                }}
              />
            </div>
            {/* 终端底部停靠（IDEA 风格）：横跨中间区域下方，不与右侧面板抢水平空间。
                常挂载（terminalStarted 后不卸载）保持 pty 会话与滚动缓冲。 */}
            {s.view === 'chat' && terminalStarted && terminalOpen && <ResizeHandle side="bottom" width={terminalHeight} min={160} max={640} onChange={setTerminalHeight} onReset={resetTerminalHeight} label="终端面板高度" />}
            {s.view === 'chat' && terminalStarted && <TerminalPanel open={terminalOpen} cwd={composerCwd} lang={s.lang} dark={s.theme==='dark'} onClose={()=>setTerminalOpen(false)}/>}
          </div>
        </>
      )}

      <GlobalSearch
        open={s.searchOpen}
        query={s.searchQuery}
        items={searchItems}
        demo={false}
        labels={t.search}
        onQuery={s.setSearchQuery}
        onClose={() => s.setSearchOpen(false)}
        onSelect={onSelectSearch}
      />
      <Notifications
        open={s.notificationsOpen}
        items={s.notifications}
        demo={false}
        labels={{ ...t.notifications, demoNote: s.lang === 'zh' ? '来自本地 pi 的事件通知。' : 'Events from the local pi runtime.' }}
        onClose={s.toggleNotifications}
        onMarkAllRead={s.markAllRead}
        onSelect={() => s.toggleNotifications()}
      />

      {modalDialog && <ExtensionDialog key={`${modalDialog.generation}:${modalDialog.request.id}`} dialog={modalDialog} />}
    </div>
    </SubagentNavigation.Provider>
  );
}

function pathLabel(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) || p;
}

/** Read-only model catalog from the local pi configuration (settings/models/auth). */
function ModelCatalogSection({
  catalog,
  loading,
  lang,
  currentModel,
  onChanged,
}: {
  catalog?: import('../../shared/pi').PiModelCatalog;
  loading: boolean;
  lang: 'en' | 'zh';
  currentModel?: string;
  onChanged: () => void;
}) {
  const zh = lang === 'zh';
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<PiCatalogProvider | 'new' | null>(null);
  const say = (text: string) => { setMsg(text); window.setTimeout(() => setMsg(null), 3500); };
  if (loading && !catalog) {
    return <div className="pi-settingrow pi-settingrow--card"><div className="pi-settingrow__text"><div className="pi-settingrow__desc">{zh ? '正在读取 pi 模型配置…' : 'Reading pi model config…'}</div></div></div>;
  }
  if (!catalog) {
    return <div className="pi-settingrow pi-settingrow--card"><div className="pi-settingrow__text"><div className="pi-settingrow__desc">{zh ? '未读取到模型配置。' : 'No model config found.'}</div></div></div>;
  }
  const save = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    try { await fn(); onChanged(); say(okText); return true; }
    catch (e) { say(String((e as Error).message || e)); return false; }
    finally { setBusy(false); }
  };
  return (
    <>
      <DefaultModelRow catalog={catalog} lang={lang} busy={busy} onSave={save} currentModel={currentModel} />
      {catalog.providers.length === 0 && (
        <div className="pi-settingrow pi-settingrow--card">
          <div className="pi-settingrow__text">
            <div className="pi-settingrow__desc">{zh ? 'models.json 中还没有自定义提供商；内置提供商登录后会显示在这里。' : 'No custom providers in models.json; signed-in built-ins will appear here.'}</div>
          </div>
        </div>
      )}
      {catalog.providers.map((p: PiCatalogProvider) => (
        <ProviderCatalogCard
          key={p.id}
          provider={p}
          defaultProvider={catalog.defaultProvider}
          defaultModel={catalog.defaultModel}
          lang={lang}
          busy={busy}
          onEdit={() => setEditing(p)}
          onRemove={() => { if (window.confirm(zh ? `删除提供商「${p.name ?? p.id}」？会从 models.json 移除，原文件先备份。` : `Remove provider "${p.name ?? p.id}" from models.json?`)) void save(() => window.localPi!.modelProviderRemove(p.id), zh ? '已删除' : 'Removed'); }}
        />
      ))}
      {editing ? (
        <ProviderForm
          provider={editing === 'new' ? null : editing}
          lang={lang}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            const ok = await save(() => window.localPi!.modelProviderSave(draft), zh ? '提供商已写入 models.json；pi CLI 共享同一份配置' : 'Provider saved to models.json');
            if (ok) setEditing(null);
          }}
        />
      ) : (
        <div style={{ display: 'flex', gap: 8, margin: '10px 0 4px' }}>
          <button className="pi-btn pi-btn--primary" disabled={busy} onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} />
            {zh ? '添加提供商' : 'Add provider'}
          </button>
          <button className="pi-btn pi-btn--outline" disabled={busy} onClick={onChanged}>
            <Icon name="refresh" size={14} />
            {zh ? '刷新' : 'Refresh'}
          </button>
        </div>
      )}
      <p className="pi-providerform__hint">
        {zh
          ? '配置直接写入本机 pi 的 settings.json / models.json，与 pi CLI 双向共享，CLI 中的修改刷新后可见。models.json 含 API Key，以 0600 权限保存；OAuth 提供商请在 pi CLI 登录管理。'
          : 'Writes go to ~/.pi/agent settings.json / models.json — shared both ways with the pi CLI. models.json holds API keys (0600); manage OAuth providers via pi login.'}
        {currentModel ? (zh ? ` 当前会话使用：${currentModel}。` : ` Current session: ${currentModel}.`) : ''}
      </p>
      {msg && <div className="pi-banner" role="status" style={{ position: 'static' }}>{msg}</div>}
    </>
  );
}

function DefaultModelRow({ catalog, lang, busy, onSave, currentModel }: {
  catalog: import('../../shared/pi').PiModelCatalog;
  lang: 'en' | 'zh';
  busy: boolean;
  currentModel?: string;
  onSave: (fn: () => Promise<unknown>, okText: string) => Promise<boolean>;
}) {
  const zh = lang === 'zh';
  const current = catalog.defaultProvider && catalog.defaultModel ? `${catalog.defaultProvider}/${catalog.defaultModel}` : '';
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const dirty = draft !== null && draft !== current;
  return (
    <div className="pi-settingrow pi-settingrow--card">
      <div className="pi-settingrow__text">
        <div className="pi-settingrow__title">{zh ? '默认模型' : 'Default model'}</div>
        <div className="pi-settingrow__desc">
          {current || (zh ? '未设置（使用 pi 内置默认）' : 'unset')}
          {currentModel ? (zh ? ` · 当前会话：${currentModel}` : ` · current: ${currentModel}`) : ''}
        </div>
      </div>
      <div className="pi-settingrow__control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          aria-label={zh ? '默认模型' : 'Default model'}
          value={value}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          style={{ minWidth: 220 }}
        >
          <option value="">{zh ? '未设置（使用 pi 内置默认）' : 'unset'}</option>
          {catalog.providers.filter((p) => p.models.length > 0).map((p) => (
            <optgroup key={p.id} label={p.name ?? p.id}>
              {p.models.map((m) => (
                <option key={`${p.id}/${m.id}`} value={`${p.id}/${m.id}`}>{m.name ?? m.id}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          className="pi-btn pi-btn--primary"
          disabled={busy || !dirty}
          onClick={() => {
            const [provider, ...rest] = (draft ?? '').split('/');
            void onSave(() => window.localPi!.modelDefaultSave({ provider: draft ? provider : undefined, model: draft ? rest.join('/') : undefined }), zh ? '默认模型已写入 settings.json' : 'Default model saved');
            setDraft(null);
          }}
        >
          {zh ? '保存' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ProviderForm({ provider, lang, busy, onCancel, onSave }: {
  provider: PiCatalogProvider | null;
  lang: 'en' | 'zh';
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: import('../../shared/pi').PiModelProviderDraft) => Promise<void>;
}) {
  const zh = lang === 'zh';
  const [id, setId] = useState(provider?.id ?? '');
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [api, setApi] = useState(provider?.api ?? 'openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [modelLines, setModelLines] = useState(
    provider?.models.map((m) => [m.id, m.name ?? '', m.contextWindow ? String(Math.round(m.contextWindow / 1000)) : '', m.reasoning ? 'y' : ''].filter(Boolean).join(' | ')).join('\n') ?? '',
  );
  const [err, setErr] = useState<string | undefined>();
  const submit = () => {
    const models = modelLines.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [mid, mname, ctx, reasoning] = line.split('|').map((x) => x.trim());
      return { id: mid, name: mname || undefined, contextWindow: ctx && /^\d+$/.test(ctx) ? Number(ctx) * 1000 : undefined, reasoning: /^y/i.test(reasoning ?? '') };
    });
    onSave({ id, name: name || undefined, baseUrl, api: api || undefined, apiKey: apiKey || undefined, models });
  };
  return (
    <div className="pi-providerform" style={{ border: '1px solid var(--pi-border)', borderRadius: 12, padding: 16, margin: '10px 0 4px' }}>
      <label>
        <span>ID {provider && <em style={{ fontStyle: 'normal', color: 'var(--pi-text-tertiary)' }}>（创建后不可改）</em>}</span>
        <input className="pi-mono" value={id} disabled={!!provider} onChange={(e) => setId(e.target.value)} placeholder="my-provider" />
      </label>
      <label><span>{zh ? '名称（可选）' : 'Name (optional)'}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label><span>Base URL</span><input className="pi-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label><span>API {zh ? '类型' : 'type'}</span><input className="pi-mono" value={api} onChange={(e) => setApi(e.target.value)} placeholder="openai-completions" /></label>
      <label>
        <span>API Key{provider?.auth === 'api_key' ? (zh ? '（已配置——留空保持不变）' : ' (configured — leave blank to keep)') : ''}</span>
        <input className="pi-mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider?.auth === 'api_key' ? '••••••••' : 'sk-…'} />
      </label>
      <label>
        <span>{zh ? '模型列表（每行一个：ID | 名称 | 上下文k | 推理y）' : 'Models (one per line: ID | name | ctx k | reasoning y)'}</span>
        <textarea rows={4} className="pi-mono" value={modelLines} onChange={(e) => setModelLines(e.target.value)} placeholder={'gpt-4o | GPT-4o | 128k\nmy-model | 自定义模型 | 32k | y'} />
      </label>
      {err && <div className="pi-shortcuts__err" role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="pi-btn pi-btn--primary" disabled={busy} onClick={() => { setErr(undefined); try { void submit(); } catch (e) { setErr(String((e as Error).message || e)); } }}>
          {zh ? (provider ? '保存修改' : '创建提供商') : provider ? 'Save' : 'Create'}
        </button>
        <button className="pi-btn pi-btn--outline" disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
      </div>
      <em className="pi-providerform__hint">{zh ? '写入 ~/.pi/agent/models.json（0600）；新建/重载 pi 会话后生效。' : 'Written to ~/.pi/agent/models.json (0600); takes effect in new/reloaded pi sessions.'}</em>
    </div>
  );
}

function ProviderCatalogCard({
  provider,
  defaultProvider,
  defaultModel,
  lang,
  busy,
  onEdit,
  onRemove,
}: {
  provider: PiCatalogProvider;
  defaultProvider?: string;
  defaultModel?: string;
  lang: 'en' | 'zh';
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const zh = lang === 'zh';
  const [open, setOpen] = useState(false);
  const isDefaultProvider = defaultProvider === provider.id;
  const authBadge =
    provider.auth === 'oauth'
      ? { text: 'OAuth', cls: 'pi-chip--new' }
      : provider.auth === 'api_key'
        ? { text: zh ? 'API Key' : 'API key', cls: 'pi-chip--new' }
        : { text: zh ? '未配置认证' : 'no auth', cls: '' };
  return (
    <div className="pi-settingrow pi-settingrow--card" style={{ alignItems: 'flex-start' }}>
      <div className="pi-settingrow__text" style={{ minWidth: 0, flex: 1 }}>
        <button
          style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Icon name="chevron-down" size={13} style={{ transform: open ? 'none' : 'rotate(-90deg)' }} />
          <ProviderLogo id={provider.id} name={provider.name} baseUrl={provider.baseUrl} size={20} />
          <span className="pi-settingrow__title">
            {provider.name ?? provider.id}
            {isDefaultProvider && (
              <span className="pi-marketcard__verified pi-settingrow__default">{zh ? '默认' : 'default'}</span>
            )}
          </span>
        </button>
        <div className="pi-settingrow__desc pi-mono">
          {[provider.baseUrl, provider.api].filter(Boolean).join(' · ') || provider.id}
          {` · ${provider.models.length} ${zh ? '个模型' : 'models'}`}
        </div>
        {open && provider.models.length > 0 && (
          <div className="pi-settingrow__desc" style={{ marginTop: 8 }}>
            {provider.models.map((m) => (
              <div key={m.id} style={{ fontFamily: 'var(--pi-font-mono)', fontSize: 12 }}>
                {m.id}
                {m.name && m.name !== m.id ? ` — ${m.name}` : ''}
                {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}
                {m.reasoning ? (zh ? ' · 推理' : ' · reasoning') : ''}
                {isDefaultProvider && defaultModel === m.id ? (zh ? ' · 默认' : ' · default') : ''}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="pi-settingrow__control" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <span className={`pi-chip ${authBadge.cls}`}>
          {provider.auth === 'api_key' || provider.auth === 'oauth' ? '🔑 ' : ''}
          {authBadge.text}
        </span>
        {provider.source === 'models.json' && (
          <>
            <button className="pi-iconbtn" aria-label={zh ? '编辑提供商' : 'Edit provider'} title={zh ? '编辑' : 'Edit'} disabled={busy} onClick={onEdit}>
              <Icon name="pencil" size={14} />
            </button>
            <button className="pi-iconbtn" aria-label={zh ? '删除提供商' : 'Remove provider'} title={zh ? '删除' : 'Remove'} disabled={busy} onClick={onRemove}>
              <Icon name="trash" size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ConnectionPane() {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  return (
    <section className="pi-settings__block">
      <h2 className="pi-settings__blocktitle">{zh ? 'pi 内核与共享数据' : 'Pi runtime and shared data'}</h2>
      <div className="pi-providerform">
        <label>
          <span>运行时</span>
          <select value={s.paths.runtime} onChange={e=>s.setPaths({runtime:e.target.value as 'auto'|'bundled'|'system'|'custom'})}>
            <option value="auto">自动（优先本机 pi，回退内置）</option>
            <option value="bundled">内置 pi（无需安装 CLI）</option><option value="system">本机 pi（自动查找）</option><option value="custom">自定义 pi 路径</option>
          </select>
        </label>
        <p>当前：{s.env?.runtime === 'bundled' ? '内置 pi' : '本机 pi'} {s.env?.version || '不可用'}{s.env?.fallback ? ' · 已回退' : ''}{s.env?.requestedRuntime === 'auto' ? ' · 自动' : ''}</p>
        {s.env?.systemVersion && s.env?.bundledVersion && s.env.systemVersion !== s.env.bundledVersion && (
          <div className="pi-settingrow pi-settingrow--card" style={{ background: 'var(--pi-bg-inset, #f6f7f9)', marginTop: 8 }}>
            <div className="pi-settingrow__text">
              <div className="pi-settingrow__title">{zh ? '版本不同步' : 'Version out of sync'}</div>
              <div className="pi-settingrow__desc">{zh ? `本机 pi ${s.env.systemVersion}，内置 pi ${s.env.bundledVersion}。` : `Local pi ${s.env.systemVersion}, bundled pi ${s.env.bundledVersion}. `}{zh ? (s.env.systemSupported ? '已优先使用本机 pi。' : '本机版本不在兼容区间，已回退内置；升级本机后自动切换。') : (s.env.systemSupported ? 'Using local pi by default.' : 'Local version unsupported; fell back to bundled. Upgrade local to switch.')}</div>
            </div>
            {s.env.systemExecutable && !s.env.systemSupported && (
              <button className="btn pi-btn--primary" style={{ alignSelf: 'flex-start' }} disabled={s.packageBusy === 'upgradeLocalPi'} onClick={s.upgradeLocalPi}>
                {s.packageBusy === 'upgradeLocalPi' ? (zh ? '升级中…' : 'Upgrading…') : (zh ? '升级本机 pi（pi update self）' : 'Upgrade local pi')}
              </button>
            )}
          </div>
        )}
        <label>
          <span>{zh ? 'pi 可执行路径' : 'pi executable'}</span>
          <input disabled={s.paths.runtime!=='custom'} value={s.paths.executable} onChange={(e) => s.setPaths({ executable: e.target.value })} />
        </label>
        <label>
          <span>{zh ? 'pi 配置目录' : 'pi agent dir'}</span>
          <input value={s.paths.agentDir} onChange={(e) => s.setPaths({ agentDir: e.target.value })} />
        </label>
        <label>
          <span>{zh ? '额外会话目录（每行一个）' : 'Extra session dirs (one per line)'}</span>
          <textarea rows={3} value={s.paths.sessionDirs} onChange={(e) => s.setPaths({ sessionDirs: e.target.value })} />
        </label>
        <button className="btn pi-btn--primary" style={{ alignSelf: 'flex-start' }} disabled={s.runs.length > 0} onClick={s.savePaths}>
          {zh ? '保存连接设置' : 'Save connection settings'}
        </button>
        {s.runs.length > 0 && <em className="pi-providerform__hint">{zh ? '修改前请先断开下方会话。' : 'Disconnect the sessions below before saving.'}</em>}
      </div>
      {s.env?.diagnostics?.length ? (
        <div className="pi-settings__rows" style={{ marginTop: 10 }}>
          {s.env.diagnostics.map((d) => (
            <div className="pi-settingrow pi-settingrow--card" key={d}>
              <div className="pi-settingrow__text">
                <div className="pi-settingrow__desc">{d}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <h2 className="pi-settings__blocktitle" style={{ marginTop: 22 }}>
        {zh ? '桌面会话连接' : 'Desktop runs'}
      </h2>
      {s.runs.map((r) => (
        <div className="pi-settingrow pi-settingrow--card" key={r.key}>
          <div className="pi-settingrow__text">
            <div className="pi-settingrow__title pi-mono">{r.cwd}</div>
            <div className="pi-settingrow__desc pi-mono">
              {r.status} · {r.key.slice(0, 10)}
            </div>
          </div>
          <div className="pi-settingrow__control">
            <button className="pi-btn pi-btn--outline" onClick={() => s.disconnectRun(r.key)}>
              {zh ? '断开' : 'Disconnect'}
            </button>
          </div>
        </div>
      ))}
      <p className="pi-providerform__hint" style={{ marginTop: 14 }}>
        {zh
          ? '已在 macOS 验证 pi 0.85.1。只读查看不会启动代理；执行会加载你信任的全局扩展。工具确认无法限制扩展直接调用 Node 的行为。认证请在 pi CLI 完成。'
          : 'pi 0.85.1 verified on macOS. Read-only browsing never starts an agent; running one loads your trusted global extensions. Tool confirmations cannot restrict extension Node access. Auth lives in the pi CLI.'}
      </p>
    </section>
  );
}


// --- desktop-ask：ask_user_question 富问题卡片 ------------------------------

interface AskOption { label: string; description?: string }
interface AskQuestion { header: string; question: string; multiSelect?: boolean; options: AskOption[] }
interface AskPayload { v?: number; questions: AskQuestion[] }
interface AskAnswer { header: string; answers: string[] }

/**
 * 每会话的阻塞交互汇总（ZCode pendingInteractionSummary / getTaskListAttention 语义）：
 * userInput=待回答的 ask_user_question，permission=待确认的工具权限；userInput 优先展示。
 * 侧栏只拿 kind/count，不携带问题与答案等 payload。
 */
export function pendingAttentionBySession(dialogs: Dialog[]): Record<string, { needsConfirm: 'userInput' | 'permission'; needsConfirmCount: number }> {
  const result: Record<string, { needsConfirm: 'userInput' | 'permission'; needsConfirmCount: number }> = {};
  for (const dialog of dialogs) {
    const isAsk = dialog.request.method === 'input' && dialog.request.title === 'desktop-ask' && parseAskPayload(dialog.request.placeholder) !== null;
    const entry = result[dialog.key] ?? { needsConfirm: 'permission' as const, needsConfirmCount: 0 };
    entry.needsConfirmCount += 1;
    if (isAsk || entry.needsConfirm === 'userInput') entry.needsConfirm = 'userInput';
    result[dialog.key] = entry;
  }
  return result;
}

/** 某条交互是否是 ask_user_question（desktop-ask）。 */
export function isAskDialog(dialog: Dialog): boolean {
  return dialog.request.method === 'input' && dialog.request.title === 'desktop-ask' && parseAskPayload(dialog.request.placeholder) !== null;
}

/** 某条交互是否是命令/工具权限审批（desktop-policy 的 confirm）。 */
export function isApprovalDialog(dialog: Dialog): boolean {
  return Boolean(dialog.request.title?.startsWith('Desktop 审批'));
}

export function parseAskPayload(raw?: string): AskPayload | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as AskPayload;
    const questions = Array.isArray(data?.questions) ? data.questions : [];
    if (!questions.length) return null;
    return {
      questions: questions.map((q) => ({
        header: String(q?.header ?? '').slice(0, 12),
        question: String(q?.question ?? ''),
        multiSelect: !!q?.multiSelect,
        options: (Array.isArray(q?.options) ? q.options : []).filter((o) => o && typeof o.label === 'string').map((o) => ({ label: String(o.label).slice(0, 80), description: typeof o.description === 'string' ? o.description.slice(0, 300) : '' })),
      })).filter((q) => q.question && q.options.length >= 2),
    };
  } catch { return null; }
}

/** AskQuestionCard: ZCode 风格富问题卡片（desktop-ask 扩展的渲染端）。导出仅供测试。 */
export function AskQuestionCard({ payload, zh, onAnswer, onCancel, stopTask, stopping }: {
  payload: AskPayload;
  zh: boolean;
  onAnswer: (answers: AskAnswer[]) => void;
  onCancel: () => void;
  stopTask: () => void;
  stopping: boolean;
}) {
  // ZCode ElicitationDialog 完整交互复刻：一次一题 + 翻页器 ‹ n/N ›；选项行无边框、
  // 悬停/选中灰底、单选数字前缀、多选方框勾选；自定义回答为常驻末行（接续编号、自增高）；
  // 键盘 Tab/↑↓ 移动焦点、Enter 推进/提交（焦点在单选项上时视作选中它）、Space 勾选多选、
  // Esc 返回上一题/忽略；底部 ⓘ 键盘提示 + 忽略 + 继续/提交。
  const questions = payload.questions;
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, { selected: string[]; custom: string }>>(
    () => Object.fromEntries(questions.map((_, i) => [i, { selected: [], custom: '' }])) as Record<number, { selected: string[]; custom: string }>,
  );
  const [activeOption, setActiveOption] = useState(-1); // 0..options.length-1 为选项行，options.length 为自定义输入行，-1 无
  const question = questions[Math.min(questionIndex, Math.max(questions.length - 1, 0))];
  const draft = drafts[questionIndex] ?? { selected: [], custom: '' };
  const customIndex = question ? question.options.length : 0;
  const customFilled = draft.custom.trim().length > 0;
  const isLast = questionIndex >= questions.length - 1;
  const isAnswered = (i: number) => {
    const d = drafts[i];
    return Boolean(d && (d.selected.length > 0 || d.custom.trim().length > 0));
  };

  const applyToggle = (base: { selected: string[]; custom: string }, label: string, multi: boolean) => {
    if (multi) return base.selected.includes(label) ? { ...base, selected: base.selected.filter(l => l !== label) } : { ...base, selected: [...base.selected, label] };
    return base.selected[0] === label ? { ...base, selected: [] } : { ...base, selected: [label] };
  };

  const toggleOption = (label: string) => {
    setDrafts(cur => ({ ...cur, [questionIndex]: applyToggle(cur[questionIndex] ?? { selected: [], custom: '' }, label, question.multiSelect ?? false) }));
  };

  const gotoQuestion = (next: number) => {
    setQuestionIndex(Math.max(0, Math.min(next, questions.length - 1)));
    setActiveOption(-1);
  };

  const continueOrSubmit = () => {
    if (!question) return;
    // 焦点落在未选中的单选项上时点继续/提交 = 意图选中它（ZCode 自动补选语义）。
    let current = drafts[questionIndex] ?? { selected: [], custom: '' };
    if (activeOption >= 0 && activeOption < question.options.length && !question.multiSelect && !current.selected.includes(question.options[activeOption].label)) {
      current = applyToggle(current, question.options[activeOption].label, false);
      setDrafts(cur => ({ ...cur, [questionIndex]: current }));
    }
    if (!(current.selected.length > 0 || current.custom.trim().length > 0)) return; // 当前题未作答不推进
    if (!isLast) {
      gotoQuestion(questionIndex + 1);
      return;
    }
    const firstUnanswered = questions.findIndex((_, i) => {
      if (i === questionIndex) return false; // 当前题刚校验过
      const d = drafts[i];
      return !(d && (d.selected.length > 0 || d.custom.trim().length > 0));
    });
    if (firstUnanswered >= 0) {
      gotoQuestion(firstUnanswered); // 有漏答题：跳到第一道未答题
      return;
    }
    onAnswer(questions.map((q, i) => {
      const d = i === questionIndex ? current : (drafts[i] ?? { selected: [], custom: '' });
      return { header: q.header || q.question.slice(0, 12), answers: [...d.selected, d.custom.trim()].filter(Boolean) };
    }));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return; // IME 组合中不接管
    if (!question) return;
    const total = question.options.length + 1; // 含自定义输入行
    const move = (delta: number) => {
      e.preventDefault();
      setActiveOption(cur => Math.max(0, Math.min((cur < 0 ? (delta > 0 ? 0 : -1) : cur + delta), total - 1)));
    };
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'Tab': move(e.shiftKey ? -1 : 1); break;
      case 'Enter':
        e.preventDefault();
        continueOrSubmit();
        break;
      case ' ':
        if (question.multiSelect && activeOption >= 0 && activeOption < question.options.length) {
          e.preventDefault();
          toggleOption(question.options[activeOption].label);
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (questionIndex > 0) gotoQuestion(questionIndex - 1);
        else onCancel();
        break;
    }
  };

  if (!question) {
    return <p className="pi-eli__empty">{zh ? '没有可回答的问题。' : 'No questions to answer.'}</p>;
  }

  const renderOption = (option: AskOption, index: number) => {
    const selected = draft.selected.includes(option.label);
    const active = activeOption === index;
    return (
      <button
        key={option.label}
        type="button"
        role={question.multiSelect ? 'checkbox' : 'option'}
        aria-checked={question.multiSelect ? selected : undefined}
        aria-selected={question.multiSelect ? undefined : selected}
        tabIndex={active || (activeOption < 0 && index === 0) ? 0 : -1}
        className={`pi-eli__opt${selected ? ' pi-eli__opt--on' : ''}${active ? ' pi-eli__opt--active' : ''}`}
        onClick={() => { setActiveOption(index); toggleOption(option.label); }}
        onFocus={() => setActiveOption(index)}
      >
        {question.multiSelect ? (
          <span className={`pi-eli__check${selected ? ' pi-eli__check--on' : ''}`}>{selected ? '✓' : ''}</span>
        ) : (
          <span className="pi-eli__num">{index + 1}.</span>
        )}
        <span className="pi-eli__optbody">
          <span className="pi-eli__optlabel">{option.label}</span>
          {option.description && <span className="pi-eli__optdesc">{option.description}</span>}
        </span>
      </button>
    );
  };

  return (
    <div
      className="pi-eli"
      role={question.multiSelect ? 'group' : 'listbox'}
      aria-label={question.question}
      tabIndex={activeOption < 0 ? 0 : -1}
      onKeyDown={onKeyDown}
    >
      <div className="pi-eli__head">
        <div className="pi-eli__title">
          {question.header && <span className="pi-eli__chip">{question.header}</span>}
          <span className="pi-eli__question" title={question.question}>{question.question}</span>
        </div>
        {questions.length > 1 && (
          <span className="pi-eli__pager">
            <button type="button" className="pi-eli__pagebtn" disabled={questionIndex === 0} aria-label={zh ? '上一题' : 'Previous question'} onClick={() => gotoQuestion(questionIndex - 1)}>‹</button>
            <span className="pi-eli__pager-count">{`${Math.min(questionIndex + 1, questions.length)} / ${questions.length}`}</span>
            <button type="button" className="pi-eli__pagebtn" disabled={isLast} aria-label={zh ? '下一题' : 'Next question'} onClick={() => gotoQuestion(questionIndex + 1)}>›</button>
          </span>
        )}
      </div>

      <div className="pi-eli__options">
        {question.options.map((o, i) => renderOption(o, i))}
        <div
          className={`pi-eli__opt pi-eli__opt--custom${customFilled ? ' pi-eli__opt--on' : ''}${activeOption === customIndex ? ' pi-eli__opt--active' : ''}`}
          role={question.multiSelect ? 'checkbox' : undefined}
          aria-checked={question.multiSelect ? customFilled : undefined}
          onClick={(e) => { if (e.target !== e.currentTarget.querySelector('textarea')) (e.currentTarget.querySelector('textarea') as HTMLTextAreaElement | null)?.focus(); }}
        >
          {question.multiSelect ? (
            <span className={`pi-eli__check${customFilled ? ' pi-eli__check--on' : ''}`}>{customFilled ? '✓' : ''}</span>
          ) : (
            <span className="pi-eli__num">{customIndex + 1}.</span>
          )}
          <textarea
            className="pi-eli__input"
            rows={1}
            value={draft.custom}
            placeholder={zh ? '输入你的回答...' : 'Type your answer...'}
            aria-label={zh ? '自定义回答' : 'Custom answer'}
            onFocus={() => setActiveOption(customIndex)}
            onChange={(e) => {
              const value = e.target.value.slice(0, 2000);
              setDrafts(cur => ({ ...cur, [questionIndex]: { ...(cur[questionIndex] ?? { selected: [], custom: '' }), custom: value } }));
              const el = e.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = `${Math.min(110, el.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              // 输入框也是末行选项：↑↓ 移动焦点由容器处理；Enter 推进/提交，IME 组合中放行。
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                continueOrSubmit();
              }
            }}
          />
        </div>
      </div>

      <div className="pi-eli__foot">
        <p className="pi-eli__note">
          <span aria-hidden="true">ⓘ</span>
          <span>{zh ? '使用 Tab / 上下键选择，回车或空格选中' : 'Tab / ↑↓ to choose, Enter or Space to select'}</span>
        </p>
        <div className="pi-eli__actions">
          <button type="button" className="pi-eli__stop" disabled={stopping} onClick={stopTask}>
            {zh ? (stopping ? '正在停止…' : '停止任务') : stopping ? 'Stopping…' : 'Stop task'}
          </button>
          <button type="button" className="pi-btn pi-btn--outline" onClick={onCancel}>{zh ? '忽略' : 'Dismiss'}</button>
          <button type="button" className="pi-btn pi-btn--primary" onClick={continueOrSubmit}>
            {!isLast ? (zh ? '继续' : 'Continue') : (zh ? '提交' : 'Submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ask_user_question 内联卡（复刻 ZCode：阻塞交互与 composer 共享 timeline bottom dock）：
 * 不再弹全局窗——问题只在本会话的对话流内展示；后台会话的提问靠侧栏「待用户确认」胶囊提示。
 */
export function InlineAskCard({ dialog }: { dialog: Dialog }) {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const r = dialog.request;
  const [stopping, setStopping] = useState(false);
  const payload = parseAskPayload(r.placeholder);
  const stopTask = async () => {
    setStopping(true);
    try { await window.localPi!.stop(dialog.key); }
    catch (error) { usePiStore.setState({error:String((error as Error).message || error)}); setStopping(false); }
  };
  if (!payload) return null;
  return (
    <section className="pi-ask-inline" role="dialog" aria-label={zh ? '需要你的选择' : 'Your input is needed'}>
      <AskQuestionCard
        payload={payload}
        zh={zh}
        onAnswer={(answers) => s.answerDialog({ id: r.id, value: JSON.stringify(answers) })}
        onCancel={() => s.answerDialog({ id: r.id, cancelled: true })}
        stopTask={stopTask}
        stopping={stopping}
      />
    </section>
  );
}

/**
 * 命令/工具权限审批内联卡（ZCode 权限交互复刻，上浮在对话框上方）：
 * 头部「需要权限」+ 工具行（图标+等待确认+文件名+目录+增删行数+展开箭头）；
 * 五选项单选：允许(仅本次)/始终允许本项目/完全访问/拒绝/告诉模型接下来应该怎么做(文字)；
 * 底部 ⓘ「使用 Tab / 上下键选择，回车确认」+ 确认按钮。默认选中「允许」；
 * ↑↓/Tab 移动选择，Enter 确认，Esc 无动作（拒绝请选第 4 项）。
 * 扩展经 RPC select 发起（响应任意值直传）：响应值 = 选项文字或自定义指引文字。
 */
export function parseApprovalRequest(rawTitle: string): { title: string; meta: { name: string; dir: string; add?: number; del?: number; cmd: string } | null; message: string } {
  const lines = rawTitle.split('\n');
  const title = lines[0] ?? rawTitle;
  let meta: { name: string; dir: string; add?: number; del?: number; cmd: string } | null = null;
  let message = '';
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('[pi-desktop-meta]')) {
      try { meta = JSON.parse(lines[i].slice('[pi-desktop-meta]'.length)) as typeof meta; } catch { meta = null; }
    } else if (lines[i].startsWith('[pi-desktop-message]')) {
      message = lines.slice(i).join('\n').slice('[pi-desktop-message]'.length);
      break;
    }
  }
  return { title, meta, message };
}

const APPROVAL_TOOL_META: Record<string, { label: string; icon: 'edit-files' | 'read-files' | 'terminal' | 'file' }> = {
  write: { label: '写入', icon: 'edit-files' },
  edit: { label: '编辑', icon: 'edit-files' },
  read: { label: '读取', icon: 'read-files' },
  bash: { label: '执行', icon: 'terminal' },
  exec: { label: '执行', icon: 'terminal' },
};

const PERMISSION_CHOICES = ['允许', '始终允许本项目', '完全访问', '拒绝'] as const;

export function InlineApprovalCard({ dialog }: { dialog: Dialog }) {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const r = dialog.request;
  const [stopping, setStopping] = useState(false);
  const [choice, setChoice] = useState(0); // 0..3 选项行；4 = 自定义指引行
  const [customText, setCustomText] = useState('');
  const [docOpen, setDocOpen] = useState(false);
  const parsed = parseApprovalRequest(r.title ?? '');
  const toolKey = parsed.title.replace(/^Desktop 审批 · /, '').trim();
  const toolMeta = APPROVAL_TOOL_META[toolKey] ?? { label: toolKey, icon: 'file' as const };
  const stopTask = async () => {
    setStopping(true);
    try { await window.localPi!.stop(dialog.key); }
    catch (error) { usePiStore.setState({error:String((error as Error).message || error)}); setStopping(false); }
  };
  const confirm = () => {
    const value = choice === 4 ? customText.trim() : PERMISSION_CHOICES[choice];
    if (choice === 4 && !value) return; // 自定义行未输入文字不提交
    s.answerDialog({ id: r.id, value });
  };
  // ZCode 权限卡键盘语义：↑↓/Tab 移动选择（即改选），Enter 确认；自定义行内 Ctrl/Cmd+Enter 提交。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const inTextarea = e.target instanceof HTMLTextAreaElement;
    if (inTextarea) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirm(); }
      return; // 自定义行内裸 Enter 留给换行/容器推进由 textarea onKeyDown 决定
    }
    switch (e.key) {
      case 'ArrowDown': case 'Tab':
        e.preventDefault();
        setChoice(c => Math.min(c + 1, 4));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setChoice(c => Math.max(c - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        confirm();
        break;
      case 'Escape':
        break; // 权限卡无忽略语义（ZCode 底部只有确认；拒绝是显式选项）
    }
  };

  return (
    <section className="pi-approval-inline" role="dialog" aria-label={zh ? '需要权限' : 'Permission required'} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="pi-approval-inline__title">{zh ? '需要权限' : 'Permission required'}</div>
      <button type="button" className="pi-approval-inline__tool" onClick={() => setDocOpen(open => !open)} aria-expanded={docOpen}>
        <Icon name={toolMeta.icon} size={14} />
        <span className="pi-approval-inline__toolstate">{zh ? '等待确认' : 'Awaiting approval'}</span>
        {parsed.meta?.cmd ? (
          <span className="pi-approval-inline__cmd" title={parsed.meta.cmd}>{parsed.meta.cmd}</span>
        ) : (
          <>
            <span className="pi-approval-inline__name">{parsed.meta?.name ?? toolKey}</span>
            {parsed.meta?.dir && <span className="pi-approval-inline__dir">{parsed.meta.dir}/</span>}
            {parsed.meta?.add !== undefined && parsed.meta.add > 0 && <span className="pi-approval-inline__add">+{parsed.meta.add}</span>}
            {parsed.meta?.del ? <span className="pi-approval-inline__del">−{parsed.meta.del}</span> : null}
          </>
        )}
        <Icon name={docOpen ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>
      {docOpen && parsed.message && <pre className="pi-approval-inline__doc" tabIndex={0}>{parsed.message}</pre>}
      <div className="pi-eli__options" role="radiogroup" aria-label={zh ? '审批选项' : 'Approval options'}>
        {PERMISSION_CHOICES.map((label, index) => {
          const desc = [
            zh ? '仅允许这一次' : 'This call only',
            zh ? '后续相同文件操作不再询问' : 'Same file operations won\'t ask again',
            zh ? '授予 Agent 完全访问权限，不再确认。' : 'Grant full access; no more confirmations.',
            zh ? '这次先拒绝' : 'Deny this call',
          ][index];
          return (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={choice === index}
              tabIndex={-1}
              className={`pi-eli__opt${choice === index ? ' pi-eli__opt--on' : ''}`}
              onClick={() => setChoice(index)}
            >
              <span className="pi-eli__num">{index + 1}.</span>
              <span className="pi-eli__optbody">
                <span className="pi-eli__optlabel">{label}</span>
                <span className="pi-eli__optdesc">{desc}</span>
              </span>
            </button>
          );
        })}
        <div className={`pi-eli__opt pi-eli__opt--custom${choice === 4 ? ' pi-eli__opt--on' : ''}`}>
          <span className="pi-eli__num">5.</span>
          <textarea
            className="pi-eli__input"
            rows={1}
            value={customText}
            placeholder={zh ? '告诉模型接下来应该怎么做...' : 'Tell the model what to do next...'}
            aria-label={zh ? '告诉模型接下来应该怎么做' : 'Tell the model what to do next'}
            onFocus={() => setChoice(4)}
            onChange={(e) => {
              setCustomText(e.target.value.slice(0, 2000));
              const el = e.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = `${Math.min(110, el.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                confirm();
              }
            }}
          />
        </div>
      </div>
      <div className="pi-eli__foot">
        <p className="pi-eli__note">
          <span aria-hidden="true">ⓘ</span>
          <span>{zh ? '使用 Tab / 上下键选择，回车确认' : 'Tab / ↑↓ to choose, Enter to confirm'}</span>
        </p>
        <div className="pi-eli__actions">
          <button type="button" className="pi-eli__stop" disabled={stopping} onClick={stopTask}>
            {zh ? (stopping ? '正在停止…' : '停止任务') : stopping ? 'Stopping…' : 'Stop task'}
          </button>
          <button type="button" className="pi-btn pi-btn--primary" onClick={confirm}>{zh ? '确认' : 'Confirm'}</button>
        </div>
      </div>
    </section>
  );
}

export function ExtensionDialog({ dialog }: { dialog: Dialog }) {
  const s = usePiStore();
  const zh = s.lang === 'zh';
  const r = dialog.request;
  const [stopping, setStopping] = useState(false);
  const stopTask = async () => {
    setStopping(true);
    try { await window.localPi!.stop(dialog.key); }
    catch (error) { usePiStore.setState({error:String((error as Error).message || error)}); setStopping(false); }
  };
  const [value, setValue] = useState(String(r.prefill ?? ''));
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') s.answerDialog({ id: r.id, cancelled: true });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.id]);
  const answer = (response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => s.answerDialog(response);
  // desktop-ask 扩展的 ask_user_question：载荷在 placeholder，回答以 JSON 提交。
  const askPayload = r.method === 'input' && r.title === 'desktop-ask' ? parseAskPayload(r.placeholder) : null;
  // 命令/工具权限审批已改走对话框上方内联卡（InlineApprovalCard），此处只处理其余扩展交互。
  const actions = (
    <footer className="pi-connectmodal__actions">
      <button className="pi-btn pi-btn--outline" disabled={stopping} onClick={stopTask}>{zh ? (stopping ? '正在停止…' : '停止任务') : 'Stop task'}</button>
      <button className="pi-btn pi-btn--outline" onClick={() => answer({ id: r.id, cancelled: true })}>
        {zh ? '取消 / 拒绝' : 'Cancel / deny'}
      </button>
      {r.method !== 'select' && (
        <button
          className="pi-btn pi-btn--primary"
          onClick={() => answer(r.method === 'confirm' ? { id: r.id, confirmed: true } : { id: r.id, value })}
        >
          {r.method === 'confirm' ? (zh ? '允许本次' : 'Allow once') : zh ? '确定' : 'OK'}
        </button>
      )}
    </footer>
  );
  return (
    <div className="pi-overlay" role="dialog" aria-modal="true" aria-label={r.title ?? 'pi'} onMouseDown={(e) => { if (e.target === e.currentTarget) answer({ id: r.id, cancelled: true }); }}>
      <div className="pi-connectmodal" onMouseDown={(e) => e.stopPropagation()}>
        <small className="pi-connectmodal__tag">{r.title === 'desktop-ask' ? (zh ? '需要你的选择' : 'Your input is needed') : isApprovalDialog(dialog) ? (zh ? '工具访问审批 · 仅本次调用' : 'Tool approval · This call only') : 'pi extension'}</small>
        {askPayload ? (
          <div className="pi-connectmodal__body">
            <AskQuestionCard payload={askPayload} zh={zh} onAnswer={(answers) => answer({ id: r.id, value: JSON.stringify(answers) })} onCancel={() => answer({ id: r.id, cancelled: true })} stopTask={stopTask} stopping={stopping} />
          </div>
        ) : (
          <>
            <div className="pi-connectmodal__body">
              <h2>{r.title ?? (zh ? '需要你的回答' : 'Your answer is needed')}</h2>
              {r.message && <pre className="pi-connectmodal__message">{r.message}</pre>}
              {r.method === 'select' ? (
                <div className="pi-connectmodal__options">
                  {r.options?.map((option, i) => (
                    <button key={option} autoFocus={i === 0} className="pi-btn pi-btn--outline" onClick={() => answer({ id: r.id, value: option })}>
                      {option}
                    </button>
                  ))}
                </div>
              ) : r.method === 'editor' ? (
                <textarea className="pi-connectmodal__editor" rows={8} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
              ) : r.method === 'input' ? (
                <input className="pi-connectmodal__input" placeholder={r.placeholder} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
              ) : null}
              {isApprovalDialog(dialog) && !r.timeout && <p>{zh ? '等待你处理，不会自动超时。' : 'Waiting for your decision. No automatic timeout.'}</p>}
            </div>
            {actions}
          </>
        )}
      </div>
    </div>
  );
}
