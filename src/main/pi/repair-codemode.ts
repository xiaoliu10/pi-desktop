import fs from 'node:fs';
import path from 'node:path';

/**
 * codemode 开关持久化防抹除（与 packages-repair 同款防御）。
 *
 * 现象：用户在 Desktop 开 codemode（写 pi settings.json 顶层 defaultTools='+codemode'），
 * pi 会话进程退出时整包写回 settings.json 的内存旧副本——若内存副本没有 defaultTools
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
    const config = readDesktopConfig(dataDir);
    let desired = config.codemode;
    // 旧用户迁移：期望字段缺失（本 PR 之前的版本不记录），但 settings 当前已开着
    // codemode（用户「之前一直开着」）——首次见到时把现状记录为期望，否则 settings
    // 被 pi 抹掉后无期望可自愈（正是用户报告的「重启后关闭」根因）。
    if (desired === undefined) {
      try {
        const settings = readSettingsDoc(path.join(agentDir, 'settings.json'));
        desired = Array.isArray(settings.defaultTools) && (settings.defaultTools as unknown[]).includes('+codemode') ? true : false;
      } catch { /* settings 损坏时按关闭迁移（不覆盖原文件） */ }
      if (desired !== undefined) { config.codemode = desired; atomicWrite(path.join(dataDir, 'pi-desktop.json'), config); }
    }
    if (desired !== true) return false; // 期望关闭或迁移为关闭：不主动干预 pi settings
    const settingsPath = path.join(agentDir, 'settings.json');
    const value = readSettingsDoc(settingsPath);
    const list = Array.isArray(value.defaultTools) ? value.defaultTools.filter((t: unknown) => typeof t === 'string') : [];
    if (list.includes('+codemode')) return false; // 已在位
    list.push('+codemode');
    value.defaultTools = list;
    atomicWrite(settingsPath, value);
    return true;
  } catch { return false; }
}

/** 记录期望的 codemode 状态（setCodemode 开关时调，作为防抹除的真理源）。
 *  损坏的 pi-desktop.json 不覆盖（保留原文件待人工恢复），仅缺失时新建。 */
export function recordCodemodeDesired(dataDir: string, enabled: boolean): void {
  const file = path.join(dataDir, 'pi-desktop.json');
  const value = readDesktopConfig(dataDir);
  value.codemode = enabled;
  atomicWrite(file, value);
}

/** 读 pi-desktop.json：缺失返回 {}；存在但损坏抛错（调用方决定静默还是拒绝）。 */
function readDesktopConfig(dataDir: string): Record<string, unknown> {
  const file = path.join(dataDir, 'pi-desktop.json');
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('pi-desktop.json 不是合法对象');
  return parsed as Record<string, unknown>;
}

/** 读 settings.json：缺失返回 {}；存在但损坏抛错（绝不静默当空对象覆盖原文件）。 */
function readSettingsDoc(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json 不是合法对象');
  return parsed as Record<string, unknown>;
}

/** 原子写：tmp + rename，避免并发/中断暴露截断文件（packages-repair 也是非原子，本模块先做对）。 */
function atomicWrite(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
