import fs from 'node:fs';
import path from 'node:path';

/**
 * pi 会话进程退出时会整包写回 settings.json 的内存旧副本，可能抹掉之后注册的包
 * （pi-memory、pi-goal-x 等都中过招）。以 dataDir/pi-desktop.json 记录的期望注册
 * 列表为准：启动会话前与打开设置页时都调用本函数补回缺失注册。
 *
 * 返回本次被恢复的包 spec；npm 依赖已卸载的包（用户 pi remove）不恢复；
 * settings.json 损坏或任何一步失败都静默跳过——修复不能反过来挡住会话启动。
 */
export function repairPackages(dataDir: string, agentDir: string): string[] {
  try {
    const desiredRaw = readJson(path.join(dataDir, 'pi-desktop.json')).piPackages as unknown[] ?? [];
    const desired = desiredRaw.filter((v): v is string => typeof v === 'string' && v.length <= 300);
    if (!desired.length) return [];
    let npmDeps: Set<string> | null = null;
    try {
      // 清单缺失 = 无法判断依赖存在与否（视为无门槛，全部补回）；与原 settings-service 语义一致。
      const npmPkg = path.join(agentDir, 'npm', 'package.json');
      if (!fs.existsSync(npmPkg)) throw new Error('missing');
      const deps = readJson(npmPkg).dependencies ?? {};
      npmDeps = new Set(Object.keys(deps).map(n => `npm:${n}`));
    } catch { npmDeps = null; }
    const wanted = npmDeps ? desired.filter(spec => !spec.startsWith('npm:') || npmDeps!.has(spec)) : desired;
    if (!wanted.length) return [];
    const settingsPath = path.join(agentDir, 'settings.json');
    const value = readJson(settingsPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const current = value.packages;
    const existing: string[] = Array.isArray(current) ? current.map((raw: unknown) => typeof raw === 'string' ? raw : typeof raw === 'object' && raw ? String((raw as { source?: unknown }).source ?? '') : '').filter(Boolean) : [];
    const missing = wanted.filter(spec => !existing.includes(spec));
    if (!missing.length) return [];
    value.packages = [...existing, ...missing];
    fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n');
    return missing;
  } catch { return []; }
}

function readJson(file: string): any {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
