/**
 * 任务清单工具：2026-10-19 起改为「npm 包优先」薄封装。
 *
 * 背景（docs/design/desktop-policy-module-audit.md）：任务纪律是质量基础设施，
 * 但原实现锁在 Desktop 内置扩展里，CLI 用不到。已拆成
 * npm:@wengine-ai/pi-plan-tool，本文件只做 re-export：
 *
 * - 装了包（settings.packages 声明，pi 自行加载）→ pi 对同名工具注册会抛错，
 *   所以 Desktop 检测到包已注册时**跳过**本文件注册（见 index.mjs 的探测）
 * - 没装包 → 本文件从 node_modules 解析包的实现；解析失败（离线/未安装）时
 *   回退到下方内置副本，保证 Desktop 永远能起会话（fail-open，与 ask/
 *   schedule/memory 的条件加载同模式）
 *
 * 为什么不直接删本文件：asar 内的实现不依赖 npm 安装状态，离线/首次启动/
 * 包被误删时会话不能起不来。包与内置副本保持逐行一致（包是源，这里镜像）。
 */

/** 内置副本（与 npm 包 index.mjs 保持一致；包优先，此为兜底）。 */
function builtinRegisterPlanTool(pi) {
  pi.registerTool({
    name: 'desktop_update_plan', label: '更新任务进度',
    description: 'Maintain the task checklist. For multi-step work, create a short plan then update it as steps start or finish. Send the entire list each time; statuses must reflect actual progress. This only stores session metadata.',
    parameters: {type:'object', required:['plan'], additionalProperties:false, properties:{plan:{type:'array',maxItems:30,items:{type:'object',required:['step','status'],additionalProperties:false,properties:{step:{type:'string',minLength:1,maxLength:500},status:{type:'string',enum:['pending','in_progress','completed']}}}}}},
    async execute(_id, args) {
      if(!Array.isArray(args.plan) || args.plan.length>30 || args.plan.some(p=>!p || typeof p.step!=='string' || !p.step.trim() || p.step.length>500 || !['pending','in_progress','completed'].includes(p.status))) throw new Error('任务清单格式无效');
      const plan=args.plan.map(({step,status})=>({step:step.trim(),status}));
      return {content:[{type:'text',text:JSON.stringify({plan})}], details:{plan}};
    }
  });
}

/** 计划模式白名单（index.mjs 用）：本工具名在 plan 模式下始终可用。 */
export const PLAN_TOOL_NAME = 'desktop_update_plan';

/** 引导语（与 npm 包导出一致；index.mjs 注入 systemPrompt 用）。 */
export const PLAN_CHECKLIST_GUIDELINE =
  'Task checklist (desktop_update_plan) is MANDATORY for any non-trivial task: each NEW user task gets its OWN checklist — do not assume an earlier checklist still applies. Before starting work, create a checklist of 3-10 steps covering the whole task. While working: keep exactly one step in_progress at a time; mark a step completed the moment it is done (never batch updates); add newly discovered steps as you go. Never mark anything completed that has not been verified.';

/** 包优先注册：pi 已加载同名工具（用户装了 npm 包）时静默跳过。 */
export function registerDesktopPlan(pi) {
  try {
    const existing = typeof pi.getTools === 'function'
      ? pi.getTools().find(t => t.name === PLAN_TOOL_NAME)
      : typeof pi.getAllTools === 'function'
        ? pi.getAllTools().find(t => t.name === PLAN_TOOL_NAME)
        : undefined;
    if (existing) return; // npm 包已注册——不重复注册（pi 对同名冲突会抛错退出）
  } catch { /* 探测失败 = 没装包，继续内置注册 */ }
  builtinRegisterPlanTool(pi);
}
