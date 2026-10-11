import type { PiCatalogModel, PiCatalogProvider, PiModel, PiModelCatalog } from '../../shared/pi';

/**
 * Provider 适配层：把「扩展注册的 provider」（pi.registerProvider，只存在于运行中
 * pi 进程内存）并入 Desktop 模型目录。三类来源合并为一等公民：
 *   native 目录（accounts worker）+ 静态文件（models.json / models-store.json / auth）
 *   + 运行时 RPC（get_available_models，任一活跃会话的 view.models 即权威快照）。
 * 静态/动态文件读不到的扩展 provider（不落盘的 registerProvider）只有这条通道可见。
 */

/**
 * 推断 provider 来自哪个扩展包：settings packages 的 npm:pi-<id> 与 provider id
 * 的朴素对应（pi-antigravity → antigravity）。纯展示用途（来源徽标），猜错无副作用。
 */
export function guessExtensionFor(providerId: string, packages: string[]): string | undefined {
  for (const spec of packages) {
    const raw = typeof spec === 'string' ? spec.replace(/^npm:/, '') : '';
    if (!raw) continue;
    // npm:pi-antigravity@^1.0 → 去掉版本段（scoped @scope/pkg@1.0 的首段 @scope 保留）
    const name = raw.split('/').map(seg => seg.startsWith('@') ? seg : seg.split('@')[0]).join('/');
    if (name === `pi-${providerId}` || name.startsWith(`pi-${providerId}-`)) return name;
  }
  return undefined;
}

/**
 * 把运行时模型（get_available_models 的扁平列表）并入目录：
 *  - provider 已存在（native/models.json/store/auth 任一来源）：只补目录里缺的模型
 *    （元数据不全的 runtime 条目绝不覆盖已有定义），并打 origin 扩展名；
 *  - provider 不存在：新增 `source:'runtime'` 条目（registerProvider 不落盘的扩展
 *    只有这条通道可见）。auth 未知 → 'none'（登录态以 auth.json/store 为准）。
 */
export function mergeRuntimeProviders(catalog: PiModelCatalog, runtimeModels: PiModel[] | undefined, packages: string[] = []): PiModelCatalog {
  if (!runtimeModels?.length) return catalog;
  const byProvider = new Map<string, PiModel[]>();
  for (const m of runtimeModels) {
    if (!m?.provider || !m.id) continue;
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  for (const [providerId, models] of byProvider) {
    const origin = guessExtensionFor(providerId, packages);
    const existing = catalog.providers.find(p => p.id === providerId);
    if (existing) {
      if (origin && !existing.originExtension) existing.originExtension = origin;
      const known = new Set(existing.models.map(m => m.id));
      const additions = models.filter(m => !known.has(m.id)).map(m => runtimeToCatalogModel(m));
      if (additions.length) existing.models.push(...additions);
      continue;
    }
    catalog.providers.push({
      id: providerId,
      name: models[0]?.name && models.length === 1 ? models[0].name : undefined,
      auth: 'none',
      source: 'runtime',
      originExtension: origin,
      models: models.map(m => runtimeToCatalogModel(m)),
    });
  }
  return catalog;
}

function runtimeToCatalogModel(m: PiModel): PiCatalogModel {
  return {
    definition: 'builtin',
    id: m.id,
    name: m.name || m.id,
    reasoning: m.reasoning,
    input: m.input,
    // runtime 条目没有 contextWindow/maxTokens 等元数据：留空，编辑走 override 时由用户补
  };
}

/** 收集当前可用于目录合并的运行时模型：优先最近活跃的 run（同 agentDir 同配置，任一即可）。 */
export function runtimeModelsFromRuns(runs: Array<{ models: PiModel[]; status: string }>): PiModel[] | undefined {
  const withModels = runs.filter(r => r.models.length > 0);
  if (!withModels.length) return undefined;
  const running = withModels.find(r => r.status === 'running') ?? withModels[0];
  return running.models;
}
