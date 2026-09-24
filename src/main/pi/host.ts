import { PiAccounts } from './accounts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiEnvironment, PiEvent, PiModelProviderDraft, PiPreferences } from '../../shared/pi';
import { discoverPi, expand } from './environment';
import { readModelCatalog, writeDefaultModel, writeModelProvider, removeModelProvider } from './model-catalog';
import { UsageStatsService } from './usage-stats';
import { SessionIndex } from './session-index';
import { PiBackend } from './backend';
import { resourceCatalog } from './resource-catalog';
import { listInstalledPackages, searchMarket, installPackage, registerPackage, packageCovers as packageCoversImpl } from './pi-packages';
import { workspaceReview } from './workspace-review';
export class PiHost {
  preferences: PiPreferences;
  environment;
  accounts = new PiAccounts(()=>this.environment.agentDir);
  index: SessionIndex;
  backend: PiBackend;
  private resourcesTimer?: ReturnType<typeof setInterval>;
  private usage = new UsageStatsService(() => this.index.scan());
  constructor(private dataDir: string, private policyPath: string, private emit: (e: PiEvent) => void, private sharedSkillsDir?: string) {
    try { this.preferences = JSON.parse(fs.readFileSync(path.join(dataDir, 'pi-desktop.json'), 'utf8')); } catch { this.preferences = {}; }
    this.environment = discoverPi(this.preferences);
    const owned = path.join(this.environment.agentDir, 'sessions', 'desktop');
    this.index = new SessionIndex([...new Set([...this.environment.sessionDirs, owned])], owned);
    this.backend = new PiBackend(this.environment, this.index, owned, policyPath, emit);
    this.index.start(() => emit({ type: 'sessions-changed' }));
    let stamp = '';
    this.resourcesTimer = setInterval(() => {
      const dirs = [this.environment.agentDir, ...this.backend.runs().map(r => path.join(r.cwd, '.pi'))];
      const next = dirs.map(dir => {
        try { return [dir, fs.statSync(dir).mtimeMs, ...['settings.json', 'extensions', 'skills', 'prompts', 'themes'].map(p => { try { return fs.statSync(path.join(dir, p)).mtimeMs; } catch { return 0; } })].join(':'); } catch { return dir; }
      }).join('|');
      if (stamp && stamp !== next) emit({ type: 'resources-changed' }); stamp = next;
    }, 2500); this.resourcesTimer.unref();
  }
  configure(input: PiPreferences) {
    if (this.backend.runs().length) throw new Error('请先断开所有桌面会话再修改连接配置。');
    if (!input || typeof input !== 'object') throw new Error('配置无效');
    for (const key of ['executable', 'agentDir'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('路径必须为字符串');
    if (input.sessionDirs !== undefined && (!Array.isArray(input.sessionDirs) || input.sessionDirs.length > 20 || input.sessionDirs.some(p => typeof p !== 'string' || !p.trim()))) throw new Error('额外会话目录无效');
    if (input.runtime !== undefined && !['auto','bundled','system','custom'].includes(input.runtime)) throw new Error('无效运行时类型');
    if(input.runtime==='custom' && !input.executable?.trim()) throw new Error('请填写自定义 pi 路径');
    this.preferences = { runtime:input.runtime, executable: input.executable?.trim() || undefined, agentDir: input.agentDir?.trim() || undefined, sessionDirs: input.sessionDirs?.map(expand) };
    fs.mkdirSync(this.dataDir, { recursive: true });
    const target = path.join(this.dataDir, 'pi-desktop.json');
    fs.writeFileSync(target + '.tmp', JSON.stringify(this.preferences, null, 2), { mode: 0o600 }); fs.renameSync(target + '.tmp', target);
    this.accounts.dispose(); this.backend.dispose(); this.index.close();
    this.environment = discoverPi(this.preferences);
    const owned = path.join(this.environment.agentDir, 'sessions', 'desktop');
    this.index = new SessionIndex([...new Set([...this.environment.sessionDirs, owned])], owned);
    this.backend = new PiBackend(this.environment, this.index, owned, this.policyPath, this.emit);
    this.index.start(() => this.emit({ type: 'sessions-changed' })); this.emit({ type: 'sessions-changed' });
    return this.environment;
  }
  /** Re-discover the pi runtime after an upgrade, without changing saved preferences. */
  refreshEnvironment(): PiEnvironment {
    this.environment = discoverPi(this.preferences);
    return this.environment;
  }
  /** Run `pi update self` against the discovered local CLI so its version can catch up to the
   *  bundled/runtime range. Returns captured output; the caller re-fetches environment after. */
  async upgradeLocalPi(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const target = this.environment.systemExecutable;
    if (!target) throw new Error('未找到本地 pi 可执行文件，无法升级。请先安装 pi CLI。');
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = spawn(target, ['update', 'self'], { cwd: os.homedir(), env: process.env });
      let stdout = '', stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > 1 << 19) stdout = stdout.slice(-1 << 19); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 1 << 19) stderr = stderr.slice(-1 << 19); });
      child.on('error', (e) => resolve({ exitCode: -1, stdout, stderr: stderr + String(e) }));
      child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    });
  }
  resources(cwd?: string) { return resourceCatalog(this.environment.agentDir, cwd, this.backend.runs().filter(r => r.cwd === cwd).flatMap(r => r.commands), this.sharedSkillsDir); }
  packageList() { return listInstalledPackages(this.environment.agentDir); }
  packageSearch(query: string) { return searchMarket(query); }
  /** README 封面候选 URL，进程内缓存一天；纯网络查询，不依赖 pi 可执行文件。 */
  packageCovers(names: string[]) { return packageCoversImpl(names); }
  /** Install/remove runs the official `pi install|remove <source>` CLI. */
  packageInstall(source: string, action: 'install' | 'remove' = 'install') { if (!this.environment.executable) return Promise.reject(new Error('pi 内核不可用')); return installPackage(this.environment.executable, source, this.dataDir, action).then(async (output) => { this.scanNotify(); return output; }); }
  /** Enable a package that exists on disk but is missing from settings.packages. */
  packageRegister(spec: string) {
    return registerPackage(this.environment.agentDir, spec).then(() => {
      // 记录期望注册列表：pi 会话进程退出/切模型时会整包写回旧设置副本覆盖 packages，
      // settings-service 的快照据此自愈补回（记忆插件被「排除」的根因）。
      try { const file = path.join(this.dataDir, 'pi-desktop.json'); const prefs = JSON.parse(fs.readFileSync(file, 'utf8')); const list = Array.isArray(prefs.piPackages) ? prefs.piPackages : []; if (!list.includes(spec)) { prefs.piPackages = [...list, spec]; fs.writeFileSync(file, JSON.stringify(prefs, null, 2) + '\n'); } } catch { if (!fs.existsSync(path.join(this.dataDir, 'pi-desktop.json'))) { try { fs.writeFileSync(path.join(this.dataDir, 'pi-desktop.json'), JSON.stringify({ piPackages: [spec] }, null, 2) + '\n'); } catch { /* 首次记录失败不影响注册 */ } } }
      this.scanNotify();
    });
  }
  private scanNotify() { this.emit({ type: 'resources-changed' }); }
  async modelCatalog() {
    const catalog=readModelCatalog(this.environment.agentDir);
    try {
      const native=await this.accounts.catalog();
      for(const provider of native){
        const existing=catalog.providers.find(p=>p.id===provider.id);
        if(existing){
          existing.loginAvailable=provider.loginAvailable;
          if(existing.auth==='none')existing.auth=provider.auth;
          if(existing.source==='auth'){existing.models=provider.models;existing.name=provider.name;}

        }else if(provider.loginAvailable)catalog.providers.push(provider);
      }
    }catch(e){catalog.warning=e instanceof Error?e.message:String(e);}
    return catalog;
  }
  modelDefaultSave(input: { provider?: string; model?: string }) { return writeDefaultModel(this.environment.agentDir, input); }
  modelProviderSave(provider: PiModelProviderDraft) { return writeModelProvider(this.environment.agentDir, provider); }
  modelProviderRemove(id: string) { return removeModelProvider(this.environment.agentDir, id); }
  usageStats() { return this.usage.get(); }
  review(cwd: string) {
    if (!this.index.scan().some(s => s.cwd === cwd) && !this.backend.runs().some(r => r.cwd === cwd)) throw new Error('请先选择该项目的会话');
    return workspaceReview(cwd);
  }
  dispose() { this.accounts.dispose(); clearInterval(this.resourcesTimer); this.index.close(); this.backend.dispose(); }
}
