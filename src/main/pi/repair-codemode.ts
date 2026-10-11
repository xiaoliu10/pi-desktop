import fs from 'node:fs';
import path from 'node:path';

/**
 * codemode 开关持久化防抹除（与 packages-repair 同款防御）。
 *
 * 现象：用户在 Desktop 开 codemode（写 pi settings.json 顶层 defaultTools='+codemode'），
 * pi 会话进程退出时整包写回 settings.json 的内存旧副本——若内存副本里没有 defaultTools
 * 段，开关被静默抹掉，重启 Desktop 后 UI 显示关闭（用户「之前一直开着」却反复回到关闭态）。
 *
 * 防御：以 dataDir/pi-desktop.json 的 codemode 布尔为期望值，启动会话前与打开设置页时
 * 补回顶层 defaultTools 里的 +codemode（期望为 true 时；期望为 false 时不动——用户若在
 * pi CLI 手动加了 codemode，Desktop 不强行剥夺）。settings.json 损坏/任何一步失败都静默
 * 跳过——修复不能反过来挡住会话启动。
 *
 * @returns true 表示本次补回了 +codemode（用于诊断/留痕）
 */
export function repairCodemode(dataDir: string, agentDir: string): boolean {
  try {
    const desired = readJson(path.join(dataDir, 'pi-desktop.json')).codemode;
    if (desired !== true) return false; // 期望关闭或未记录：不主动干预 pi settings
    const settingsPath = path.join(agentDir, 'settings.json');
    const value = readJson(settingsPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const list = Array.isArray(value.defaultTools) ? value.defaultTools.filter((t: unknown) => typeof t === 'string') : [];
    if (list.includes('+codemode')) return false; // 已在位
    list.push('+codemode');
    value.defaultTools = list;
    fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n');
    return true;
  } catch { return false; }
}

/** 记录期望的 codemode 状态（setCodemode 开关时调，作为防抹除的真理源）。 */
export function recordCodemodeDesired(dataDir: string, enabled: boolean): void {
  const file = path.join(dataDir, 'pi-desktop.json');
  const value = readJson(file);
  value.codemode = enabled;
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file: string): any {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}
