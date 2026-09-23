export const ACCESS_MODES = ['plan', 'ask', 'autoEdit', 'fullAccess'] as const;
export type AccessMode = typeof ACCESS_MODES[number];
export const isAccessMode = (value: unknown): value is AccessMode => ACCESS_MODES.includes(value as AccessMode);
export const ACCESS_LABELS: Record<AccessMode, string> = { plan: '计划模式', ask: '变更前确认', autoEdit: '自动编辑', fullAccess: '完全访问' };
