import fs from 'node:fs';
import path from 'node:path';

/**
 * 第三方 ask_user_question 插件共生（与 official-subagent.ts 的 detectThirdPartySubagent 同模式）：
 * pi 对同名工具的注册冲突会在扩展加载阶段直接抛错退出（实测 -e desktop-ask 与
 * rpiv-ask-user-question 并存时进程退出码 1），所以 desktop-ask 必须在 launch 层条件省略；
 * 第三方插件供题后，Desktop 在 RPC 事件层把它的原生 select/input 桥接成富问题卡片。
 */

/** 第三方 ask 插件的识别特征：工具名（支持 - _ . 分隔）或 rpiv 前缀。 */
const ASK_PLUGIN_PATTERN = /ask[-_.]?user[-_.]?question|rpiv-ask/i;

/** 名字以 desktop 起段的是 Desktop 自带扩展（desktop-ask 等），不算第三方。
 *  锚定到末段段首而非裸 substring：第三方包名中段含 desktop（如 my-desktop-ask-user-question）
 *  不该被排除——漏检的代价是 pi 扩展加载冲突、会话起不来。 */
function looksDesktopNamed(name: string): boolean {
  const last = name.replace(/^npm:/i, '').split('/').pop() ?? '';
  return /^desktop([_.-]|$)/i.test(last);
}

/**
 * 检测用户是否安装了第三方 ask_user_question 插件（任一命中即 detected）。
 * 覆盖三种安装形态：settings.json packages 注册、agentDir/extensions/ 手装目录、
 * agentDir/npm/node_modules/ 下带 pi.extensions 清单的 autoload 包（rpiv 的实际形态）。
 * 注：本轮只检测 agentDir；项目级 <cwd>/.pi/settings.json 暂不扫描。
 * 已知局限：纯名字启发式，注册同名工具但包名不含特征的插件（如 pi-claude-tools）防不住，
 * 与 detectThirdPartySubagent 同边界；未来可考虑启动期捕获 tool 冲突错误做运行时兑底。
 */
export function detectThirdPartyAsk(agentDir: string): { detected: boolean; source?: string } {
  // 1) settings.json packages[]（pi 两种形态都写：字符串或 {source}）。
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    const pkgs: unknown[] = Array.isArray(settings?.packages) ? settings.packages : [];
    for (const p of pkgs) {
      const s = typeof p === 'string' ? p : typeof p === 'object' && p ? String((p as { source?: unknown }).source ?? '') : '';
      if (s && ASK_PLUGIN_PATTERN.test(s) && !looksDesktopNamed(s)) return { detected: true, source: s };
    }
  } catch { /* settings may not exist yet */ }
  // 2) agentDir/extensions/ 目录（git clone 形态的手装扩展）。
  try {
    const extDir = path.join(agentDir, 'extensions');
    if (fs.existsSync(extDir)) {
      for (const name of fs.readdirSync(extDir)) {
        if (!ASK_PLUGIN_PATTERN.test(name) || looksDesktopNamed(name)) continue;
        try {
          if (fs.statSync(path.join(extDir, name)).isDirectory()) return { detected: true, source: name };
        } catch { /* A stale symlink must not hide other installed extensions. */ }
      }
    }
  } catch { /* unreadable extensions dir */ }
  // 3) autoload 形态：pi 自动扫描 npm/node_modules/ 下带 pi.extensions 清单的包
  //    （settings.json 无 packages 键也会被捞进来）。兼容 npm 的 @scope/name 两级目录。
  try {
    const nmDir = path.join(agentDir, 'npm', 'node_modules');
    const dirs: Array<{ name: string; dir: string }> = [];
    if (fs.existsSync(nmDir)) {
      for (const entry of fs.readdirSync(nmDir)) {
        if (entry.startsWith('@')) {
          const scopeDir = path.join(nmDir, entry);
          let entries: string[];
          try { entries = fs.readdirSync(scopeDir); } catch { continue; }
          for (const sub of entries) {
            dirs.push({ name: `${entry}/${sub}`, dir: path.join(scopeDir, sub) });
          }
        } else dirs.push({ name: entry, dir: path.join(nmDir, entry) });
      }
    }
    for (const { name, dir } of dirs) {
      let pkg: { name?: unknown; pi?: { extensions?: unknown } };
      try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
      // Only packages declaring pi.extensions are autoload candidates.
      if (!Array.isArray(pkg?.pi?.extensions)) continue;
      const pkgName = String(pkg?.name ?? '');
      if ((ASK_PLUGIN_PATTERN.test(pkgName) || ASK_PLUGIN_PATTERN.test(name)) && !looksDesktopNamed(pkgName) && !looksDesktopNamed(name)) {
        return { detected: true, source: pkgName || name };
      }
    }
  } catch { /* best-effort detection */ }
  return { detected: false };
}

/** 桥接用的问题形状（与渲染层 parseAskPayload / desktop-ask normalizeQuestions 同构）。 */
export interface AskBridgeOption { label: string; description: string }
export interface AskBridgeQuestion { header: string; question: string; multiSelect: boolean; options: AskBridgeOption[] }

/** desktop-ask 卡片容量上限；超出即不桥接，原生 select/input 走通用对话框降级。 */
export const MAX_BRIDGE_QUESTIONS = 4;
export const MAX_BRIDGE_OPTIONS = 4;

/** The unchanged renderer also truncates descriptions to 300 characters. */
const MAX_BRIDGED_DESCRIPTION = 300;

/**
 * 从 ask_user_question 的 tool_call args 提取可桥接的问题，规范成 AskPayload 形状。
 * 不可桥接（超卡片容量、缺 question、选项 <2）返回 null → 不 stash，原生请求走通用对话框降级。
 */
export function bridgeableQuestions(args: unknown): AskBridgeQuestion[] | null {
  const raw = (args as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BRIDGE_QUESTIONS) return null;
  const questions: AskBridgeQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown; } | null | undefined;
    if (!q || typeof q.question !== 'string' || !q.question.trim()) return null;
    const options = (Array.isArray(q.options) ? q.options : []) as Array<{ label?: unknown; description?: unknown; preview?: unknown }>;
    // Preserve native indices: never filter invalid options and silently renumber them.
    if (options.length < 2 || options.length > MAX_BRIDGE_OPTIONS || options.some(o => !o || typeof o.label !== 'string' || !o.label.trim())) return null;
    const valid = options;
    const labels = valid.map(o => String(o.label).trim().slice(0, 80));
    if (new Set(labels).size !== labels.length) return null;
    questions.push({
      header: String(q.header ?? '').trim().slice(0, 12) || `问题 ${i + 1}`,
      question: q.question.trim(),
      multiSelect: !!q.multiSelect,
      options: valid.map(o => {
        const label = String(o.label).trim().slice(0, 80);
        let description = typeof o.description === 'string' ? o.description.slice(0, 300) : '';
        // rpiv 选项可带 preview（代码片段等长文本）：折进 description 尾部，卡片可读、模型不受影响。
        if (typeof o.preview === 'string' && o.preview.trim()) {
          const preview = `\n\n[预览] ${o.preview.trim()}`.slice(0, MAX_BRIDGED_DESCRIPTION);
          description = description.slice(0, MAX_BRIDGED_DESCRIPTION - preview.length) + preview;
        }
        return { label, description };
      }),
    });
  }
  return questions;
}

export type AskBridgePlanKind = 'option' | 'sentinel' | 'multi' | 'custom' | 'empty';
export interface AskBridgePlanEntry {
  kind: AskBridgePlanKind;
  /** 回给原生请求的 value。 */
  value: string;
  /** kind='sentinel'：哨兵编号应答后插件会紧跟一个 ui.input 收自由文本，此为该次应回的文本。 */
  custom?: string;
}

/**
 * 把桌面卡片的答案（answers = 选中 labels + 自定义文本）转为该题的原生响应值。
 * 原生协议（rpiv rpc-fallback）：单选 select 按 parseInt 前导数字取项，哨兵编号选中后
 * 紧跟 ui.input 收自定义；多选是单个 ui.input，"1,3"=选编号、非编号文本=自定义答案、
 * 空串=deliberate empty commit。
 * 协议边界：多选自定义文本若恰好是纯数字（如 "2"），rpiv 会解析成选项编号——原生协议
 * 本就歧义，此处不改写；最坏 plan 错位一次，后续请求 fail-open 兑底，不挂起。
 */
export function planAnswer(questions: AskBridgeQuestion[], questionIndex: number, answers: string[]): AskBridgePlanEntry {
  const q = questions[questionIndex];
  if (!q || q.options.length === 0) return { kind: 'empty', value: '' };
  const labels = new Set(q.options.map(o => o.label));
  const list = Array.isArray(answers) ? answers : [];
  const customParts = list.filter(a => !labels.has(a));
  if (!q.multiSelect) {
    const first = list[0];
    // The native protocol cannot express an option plus custom text. Prefer the
    // custom answer rather than silently discarding text entered on the card.
    if (list.length === 1 && first && labels.has(first)) return { kind: 'option', value: String(q.options.findIndex(o => o.label === first) + 1) };
    // 未命中选项（纯自定义或空）→ 哨兵编号，插件随后会发 ui.input 收自由文本。
    return { kind: 'sentinel', value: String(q.options.length + 1), custom: customParts[0] ?? '' };
  }
  if (!list.length) return { kind: 'empty', value: '' };
  if (list.every(a => labels.has(a))) {
    return { kind: 'multi', value: list.map(a => String(q.options.findIndex(o => o.label === a) + 1)).join(',') };
  }
  // The card has one custom field. Preserve that text verbatim.
  return { kind: 'custom', value: customParts[0] ?? '' };
}

/** 一份进行中的问卷桥：卡片应答后按 plan 自动推进后续原生请求。 */
export interface AskBridgeState {
  questions: AskBridgeQuestion[];
  /** 首个原生请求 id：合成 desktop-ask 卡片复用同一 id，respond 据此命中。 */
  requestId: string;
  toolCallId: string;
  plan: AskBridgePlanEntry[];
  answered: boolean;
  cancelled: boolean;
  currentQuestionIndex: number;
  /** 当前题哨兵编号已应答，正等待插件收自由文本的 ui.input（期间不推进题号）。 */
  awaitingSentinelInput: boolean;
}
