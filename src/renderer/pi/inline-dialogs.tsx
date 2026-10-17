/**
 * 阻塞交互内联卡片（主对话与副驾面板共用）：
 * ask_user_question 富问题卡 + 命令/工具权限审批卡。
 *
 * 从 PiReplicaApp 拆出：副驾面板（SidecarPanel）也要渲染同款卡片，而 PiReplicaApp 已
 * import SidecarPanel——放在同一文件会形成循环 import。此文件只依赖 adapter 的 store
 * 与 Dialog 类型、replica 的 Icon，不 import 任何面板。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../replica/Icons';
import { usePiStore, type Dialog } from './adapter';

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
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep keyboard highlight and DOM focus in sync, including the custom input.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const customRef = useRef<HTMLTextAreaElement>(null);
  // 卡片出现/翻页时自动聚焦：方向键/Tab 的 onKeyDown 挂在容器上，焦点不在卡内就完全
  // 失效（用户从 composer 或别处按 ↑↓ 毫无反应）。卡片显示时 composer 已被替换，这里
  // 抢焦点没有副作用；用户点进自定义输入框后焦点自然移交。
  useEffect(() => { containerRef.current?.focus(); }, [questionIndex]);
  // 窗口重聚焦兑底：对话框可能在窗口失焦时挂载（focus() 静默失败），或焦点被点到卡外；
  // 回窗时若焦点已不在卡内则收回，否则 ↑↓ 毫无反应。
  useEffect(() => {
    const onWinFocus = () => {
      const el = containerRef.current;
      if (el && !el.contains(document.activeElement)) el.focus();
    };
    window.addEventListener('focus', onWinFocus);
    return () => window.removeEventListener('focus', onWinFocus);
  }, []);
  const [drafts, setDrafts] = useState<Record<number, { selected: string[]; custom: string }>>(
    () => Object.fromEntries(questions.map((_, i) => [i, { selected: [], custom: '' }])) as Record<number, { selected: string[]; custom: string }>,
  );
  const [activeOption, setActiveOption] = useState(-1); // 0..options.length-1 为选项行，options.length 为自定义输入行，-1 无
  const pendingOptionFocus = useRef(false);
  const [, requestOptionFocus] = useState(0);
  useLayoutEffect(() => {
    if (!pendingOptionFocus.current) return;
    pendingOptionFocus.current = false;
    const target = optionRefs.current[activeOption] ?? customRef.current;
    target?.focus();
  });
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

  const continueOrSubmit = (override?: { selected: string[]; custom: string }) => {
    if (!question) return;
    // 焦点落在未选中的单选项上时点继续/提交 = 意图选中它（ZCode 自动补选语义）。
    // override：双击选项时传入显式选中的草稿（避开 click/dblclick 之间 toggle 中间态读到旧值）。
    let current = override ?? drafts[questionIndex] ?? { selected: [], custom: '' };
    if (!override && activeOption >= 0 && activeOption < question.options.length && !question.multiSelect && !current.selected.includes(question.options[activeOption].label)) {
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
      // Do not steal focus from pager or footer controls.
      const target = e.target as HTMLElement;
      if (target !== containerRef.current && !target.closest('[data-card-options]')) return;
      e.preventDefault();
      // Keep the updater pure; focus after commit so onFocus cannot enqueue a stale index.
      pendingOptionFocus.current = true;
      requestOptionFocus(cur => cur + 1); // Also commit focus when clamped at a boundary.
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
        ref={(el) => { optionRefs.current[index] = el; }}
        role={question.multiSelect ? 'checkbox' : 'option'}
        aria-checked={question.multiSelect ? selected : undefined}
        aria-selected={question.multiSelect ? undefined : selected}
        tabIndex={active || (activeOption < 0 && index === 0) ? 0 : -1}
        className={`pi-eli__opt${selected ? ' pi-eli__opt--on' : ''}${active ? ' pi-eli__opt--active' : ''}`}
        onClick={() => { setActiveOption(index); toggleOption(option.label); }}
        onDoubleClick={() => {
          // ZCode 同款：双击选项 = 定为选中并立即推进/提交（绕过单击 toggle 的中间态）。
          setActiveOption(index);
          const base = drafts[questionIndex] ?? { selected: [], custom: '' };
          const next = question.multiSelect
            ? (base.selected.includes(option.label) ? base : { ...base, selected: [...base.selected, option.label] })
            : { ...base, selected: [option.label] };
          setDrafts(cur => ({ ...cur, [questionIndex]: next }));
          continueOrSubmit(next);
        }}
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
      ref={containerRef}
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

      <div className="pi-eli__options" data-card-options>
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
            ref={customRef}
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
                e.stopPropagation(); // The container must not submit the same answer again.
                continueOrSubmit();
              }
            }}
          />
        </div>
      </div>

      <div className="pi-eli__foot">
        <button type="button" className="pi-btn pi-btn--danger" disabled={stopping} onClick={stopTask}>
          {zh ? (stopping ? '正在停止…' : '停止任务') : stopping ? 'Stopping…' : 'Stop task'}
        </button>
        <p className="pi-eli__note">
          <span aria-hidden="true">ⓘ</span>
          <span>{zh ? '使用 Tab / 上下键选择，回车或空格选中' : 'Tab / ↑↓ to choose, Enter or Space to select'}</span>
        </p>
        <div className="pi-eli__actions">
          <button type="button" className="pi-btn pi-btn--outline" onClick={onCancel}>{zh ? '忽略' : 'Dismiss'}</button>
          <button type="button" className="pi-btn pi-btn--primary" onClick={() => continueOrSubmit()}>
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
 * 命令/工具权限审批内联卡（ZCode 权限交互复刻，替换输入框位置——审批期间 composer 不可见）：
 * 头部「需要权限」+ 工具行（图标+等待确认+文件名+目录+增删行数+展开箭头）；
 * 五选项单选：允许(仅本次)/始终允许本项目/完全访问/拒绝/告诉模型接下来应该怎么做(文字)；
 * 底部 ⓘ「使用 Tab / 上下键选择，回车确认」+ 确认按钮。默认选中「允许」；
 * 挂载即抢焦点：↑↓/Tab 移动选择，Enter 确认，单击选项改选、双击直接提交，Esc 无动作（拒绝请选第 4 项）。
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
  // 卡片替换 composer 显示时抢键盘焦点：↑↓/Tab/Enter 不需要先点一下才生效
  // （与 AskQuestionCard/ExtensionDialog 同款；后续点击选项按钮，keydown 仍冒泡到这里）。
  const containerRef = useRef<HTMLElement>(null);
  // Keep keyboard selection and DOM focus in sync, including the custom input.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const customRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { containerRef.current?.focus(); }, []);
  // 窗口重聚焦兑底（同 AskQuestionCard）：焦点不在卡内则收回，否则 ↑↓/Tab 无反应。
  useEffect(() => {
    const onWinFocus = () => {
      const el = containerRef.current;
      if (el && !el.contains(document.activeElement)) el.focus();
    };
    window.addEventListener('focus', onWinFocus);
    return () => window.removeEventListener('focus', onWinFocus);
  }, []);
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
  const pendingChoiceFocus = useRef(false);
  const [, requestChoiceFocus] = useState(0);
  useLayoutEffect(() => {
    if (!pendingChoiceFocus.current) return;
    pendingChoiceFocus.current = false;
    (optionRefs.current[choice] ?? customRef.current)?.focus();
  });
  // Arrow keys and Tab select and focus a row; Enter confirms.
  const moveChoice = (delta: number) => {
    // Keep the updater pure; also commit focus when clamped at a boundary.
    pendingChoiceFocus.current = true;
    requestChoiceFocus(cur => cur + 1);
    setChoice(cur => Math.max(0, Math.min(cur + delta, 4)));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const inTextarea = e.target instanceof HTMLTextAreaElement;
    if (inTextarea && e.key === 'Enter') {
      // Plain Enter is handled by the textarea; preserve modified Enter without double submission.
      if (!e.defaultPrevented && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirm(); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp': case 'Tab': {
        // Do not steal focus from the tool row, document, or footer controls.
        const target = e.target as HTMLElement;
        if (target !== containerRef.current && !target.closest('[data-card-options]')) return;
        e.preventDefault();
        moveChoice(e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
        break;
      }
      case 'Enter':
        e.preventDefault();
        confirm();
        break;
      case 'Escape':
        break; // 权限卡无忽略语义（ZCode 底部只有确认；拒绝是显式选项）
    }
  };

  return (
    <section ref={containerRef} className="pi-approval-inline" role="dialog" aria-label={zh ? '需要权限' : 'Permission required'} tabIndex={0} onKeyDown={onKeyDown}>
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
      <div className="pi-eli__options" role="radiogroup" aria-label={zh ? '审批选项' : 'Approval options'} data-card-options>
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
              ref={(el) => { optionRefs.current[index] = el; }}
              role="radio"
              aria-checked={choice === index}
              tabIndex={-1}
              className={`pi-eli__opt${choice === index ? ' pi-eli__opt--on' : ''}`}
              onClick={() => setChoice(index)}
              onDoubleClick={() => { setChoice(index); confirm(); }}
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
            ref={customRef}
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
        <button type="button" className="pi-btn pi-btn--danger" disabled={stopping} onClick={stopTask}>
          {zh ? (stopping ? '正在停止…' : '停止任务') : stopping ? 'Stopping…' : 'Stop task'}
        </button>
        <p className="pi-eli__note">
          <span aria-hidden="true">ⓘ</span>
          <span>{zh ? '使用 Tab / 上下键选择，回车确认，Shift+Enter 换行' : 'Tab / ↑↓ to choose, Enter to confirm, Shift+Enter for newline'}</span>
        </p>
        <div className="pi-eli__actions">
          <button type="button" className="pi-btn pi-btn--primary" onClick={confirm}>{zh ? '确认' : 'Confirm'}</button>
        </div>
      </div>
    </section>
  );
}
