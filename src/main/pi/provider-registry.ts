import type { PiCatalogModel, PiCatalogProvider, PiModel, PiModelCatalog } from '../../shared/pi';

/**
 * Provider 适配层：把「扩展注册的 provider」（pi.registerProvider，只存在于运行中
 * pi 进程内存）并入 Desktop 模型目录。三类来源合并为一等公民：
 *   native 目录（accounts worker）+ 静态文件（models.json / models-store.json / auth）
 *   + 运行时 RPC（get_available_models，任一活跃会话的 view.models 即权威快照）。
 * 静态/动态文件读不到的扩展 provider（不落盘的 registerProvider）只有这条通道可见。
 */

/**
 * settings.json packages 的字符串形态提取（pi 两种形态都写：字符串或 {source}，
 * 与 official-subagent/third-party-ask 同款兼容）。
 */
export function packagesFromSettings(settings: unknown): string[] {
  const list = (settings as { packages?: unknown } | null | undefined)?.packages;
  if (!Array.isArray(list)) return [];
  return list.map(entry => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const source = (entry as { source?: unknown }).source;
      if (typeof source === 'string') return source;
    }
    return '';
  }).filter(Boolean);
}

/**
 * 推断 provider 来自哪个扩展包：settings packages 的 npm:pi-<id> 与 provider id
 * 的朴素对应（pi-antigravity → antigravity）。纯展示用途（来源徽标），猜错无副作用。
 * 两段式：先精确 pi-<id>，再前缀 pi-<id>-*（避免 pi-antigravity 抢先命中
 * provider=antigravity-extra 这类前缀包含关系）。
 */
export function guessExtensionFor(providerId: string, packages: string[]): string | undefined {
  const normalize = (spec: string) => spec.replace(/^npm:/, '').split('/').map(seg => seg.startsWith('@') ? seg : seg.split('@')[0]).join('/');
  const names = packages.map(normalize).filter(Boolean);
  for (const name of names) if (name === `pi-${providerId}`) return name;
  for (const name of names) if (name.startsWith(`pi-${providerId}-`)) return name;
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
  const seenModel = new Set<string>();
  for (const m of runtimeModels) {
    if (!m?.provider || !m.id) continue;
    const dedupe = `${m.provider}::${m.id}`;
    if (seenModel.has(dedupe)) continue;
    seenModel.add(dedupe);
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

/**
 * 收集当前可用于目录合并的运行时模型：跨 run 取**并集**（按 provider+id 去重）。
 * 「同 agentDir 同配置」不成立——项目级扩展（<cwd>/.pi）让不同 run 注册的 provider
 * 集合可能不同，单快照会让目录随「哪个 run 被采样」非确定漂移。
 */
export function runtimeModelsFromRuns(runs: Array<{ models: PiModel[]; status: string }>): PiModel[] | undefined {
  const seen = new Set<string>();
  const union: PiModel[] = [];
  for (const run of runs) {
    for (const m of run.models) {
      if (!m?.provider || !m.id) continue;
      const dedupe = `${m.provider}::${m.id}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      union.push(m);
    }
  }
  return union.length ? union : undefined;
}
