import fs from 'node:fs';
import path from 'node:path';
import { packageNameOf } from './package-spec';

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
    // 按包名比对依赖清单：期望 spec 常带版本范围（npm:X@^1.0）而 deps 键是裸名
    // （npm:X），精确字符串比对会把已安装的包误判为已卸载、拒绝补回。
    const wanted = npmDeps ? desired.filter(spec => !spec.startsWith('npm:') || npmDeps!.has(`npm:${packageNameOf(spec)}`)) : desired;
    if (!wanted.length) return [];
    const settingsPath = path.join(agentDir, 'settings.json');
    const value = readJson(settingsPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const current = value.packages;
    const existing: string[] = Array.isArray(current) ? current.map((raw: unknown) => typeof raw === 'string' ? raw : typeof raw === 'object' && raw ? String((raw as { source?: unknown }).source ?? '') : '').filter(Boolean) : [];
    // 同一包名只算已注册一次、写回时折叠重复（保留首次出现的写法）：期望列表里
    // 「带版本范围」与「裸名」并存时，精确字符串比对会把同一个包补两遍。
    const deduped: string[] = [];
    const registeredNames = new Set<string>();
    for (const spec of existing) {
      const name = packageNameOf(spec);
      if (registeredNames.has(name)) continue;
      registeredNames.add(name);
      deduped.push(spec);
    }
    const missing: string[] = [];
    const missingNames = new Set<string>();
    for (const spec of wanted) {
      const name = packageNameOf(spec);
      if (registeredNames.has(name) || missingNames.has(name)) continue;
      missingNames.add(name);
      missing.push(spec);
    }
    if (!missing.length && deduped.length === existing.length) return [];
    value.packages = [...deduped, ...missing];
    fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n');
    return missing;
  } catch { return []; }
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // 保留「损坏即抛」语义：调用方 repairPackages 的外层 try/catch 据此整体跳过修复。
    // 绝不能把损坏的 settings.json 当空对象继续走写回分支——那会用只含 packages 的
    // 新对象覆盖用户其余配置。这里只补文件名上下文，不改变抛出行为。
    throw new Error(`无法解析 ${path.basename(file)}：${(error as Error).message}`);
  }
}
