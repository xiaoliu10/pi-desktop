/** A session-only checklist: never executes commands or modifies project files. */
export function registerDesktopPlan(pi) {
  pi.registerTool({
    name: 'desktop_update_plan', label: '更新任务进度',
    description: 'Maintain the Desktop task checklist. For multi-step work, create a short plan then update it as steps start or finish. Send the entire list each time; statuses must reflect actual progress. This only stores session metadata.',
    parameters: {type:'object', required:['plan'], additionalProperties:false, properties:{plan:{type:'array',maxItems:30,items:{type:'object',required:['step','status'],additionalProperties:false,properties:{step:{type:'string',minLength:1,maxLength:500},status:{type:'string',enum:['pending','in_progress','completed']}}}}}},
    async execute(_id, args) {
      if(!Array.isArray(args.plan) || args.plan.length>30 || args.plan.some(p=>!p || typeof p.step!=='string' || !p.step.trim() || p.step.length>500 || !['pending','in_progress','completed'].includes(p.status))) throw new Error('任务清单格式无效');
      const plan=args.plan.map(({step,status})=>({step:step.trim(),status}));
      return {content:[{type:'text',text:JSON.stringify({plan})}], details:{plan}};
    }
  });
}
