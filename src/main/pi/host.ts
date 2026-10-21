import { PiAccounts } from './accounts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiEnvironment, PiEvent, PiModelProviderDraft, PiPreferences } from '../../shared/pi';
import { discoverPi, expand } from './environment';
import { readModelCatalog, mergeModelCatalog, writeDefaultModel, writeModelProvider, removeModelProvider, writeProviderApiKey, fetchProviderModels } from './model-catalog';
import { mergeRuntimeProviders, packagesFromSettings, runtimeModelsFromRuns } from './provider-registry';
import { UsageStatsService } from './usage-stats';
import type { IndexPort } from './index-port';
import { IndexWorkerClient } from './index-client';
import { utilityTransport } from './index-transport';
import { PiBackend } from './backend';
import { SidecarService } from './sidecar-service';
import { resourceCatalog } from './resource-catalog';
import { listInstalledPackages, searchMarket, installPackage, registerPackage, packageCovers as packageCoversImpl } from './pi-packages';
import { workspaceReview } from './workspace-review';

/** 打包后 index-worker-entry.js 及其全部 require 闭包在 asar 外（asarUnpack 目录级
 *  dist/main/pi/** + dist/shared/**），utility process 的 CJS loader 读不了 asar 内模块，
 *  缺一个就 MODULE_NOT_FOUND code=1，重试耗尽后 fatal——0.1.32 发布事故（会话列表全空）。
 *  闭包完整性由 tests/index-worker-unpack-closure.test.ts 守护：新增依赖漏 unpack 会红。
 *  开发/测试（非 asar）路径不变；打包环境把 __dirname 里的 app.asar 段替换为
 *  app.asar.unpacked（asarUnpack 产物所在目录）。 */
function workerEntryPath(): string {
  const p = path.join(__dirname, 'index-worker-entry.js');
  return p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

export class PiHost {
  preferences: PiPreferences;
  environment;
  readonly dataDir: string;
  accounts = new PiAccounts(()=>this.environment.agentDir);
  index: IndexPort;
  backend: PiBackend;
  sidecar: SidecarService;
  private resourcesTimer?: ReturnType<typeof setInterval>;
  private usage = new UsageStatsService(() => this.index.usageStatsAsync());
  constructor(dataDir: string, private policyPath: string, private emit: (e: PiEvent) => void, private sharedSkillsDir?: string, private appVersion?: string) {
    this.dataDir = dataDir;
    try { this.preferences = JSON.parse(fs.readFileSync(path.join(dataDir, 'pi-desktop.json'), 'utf8')); } catch { this.preferences = {}; }
    this.environment = this.withAppVersion(discoverPi(this.preferences));
    this.index = this.createIndex();
    this.backend = new PiBackend(this.environment, this.index, ownedRootOf(this.environment), policyPath, emit, this.dataDir);
    this.sidecar = new SidecarService(this.backend, this.index, this.dataDir, emit);
    void this.index.start(() => this.emit({ type: 'sessions-changed' }));
    let stamp = '';
    // 30s + 异步 stat：旧版 2.5s 周期、每个 run 的 .pi 做 6 次同步 statSync
    // ——大会话打字卡顿「CPU 不高」的实证来源（fs_usage 不可用时，main-perf.log
    // 每 5s 一段 400ms-1.6s event-loop 阻塞与它逐拍对齐；同步 IO 不烧 CPU 只
    // 堵线程）。resources-changed 只服务「用户在外部改了扩展/技能」的提示，
    // 30s 粒度足够（用户改完文件不会秒级就要看到提示）。
    // 无活跃 run 时只查 agentDir 一个目录；stat 全部异步，不再阻塞 event loop。
    let inFlight = false;
    this.resourcesTimer = setInterval(() => {
      if (inFlight) return; // 上一拍没完成（慢盘/大目录树）就跳过，绝不叠拍
      inFlight = true;
      const dirs = [this.environment.agentDir, ...this.backend.runs().map(r => path.join(r.cwd, '.pi'))];
      Promise.all(dirs.map(async dir => {
        try {
          const stampOf = async (p: string) => { try { return (await fs.promises.stat(p)).mtimeMs; } catch { return 0; } };
          return [dir, await stampOf(dir), ...await Promise.all(['settings.json', 'extensions', 'skills', 'prompts', 'themes'].map(p => stampOf(path.join(dir, p))))].join(':');
        } catch { return dir; }
      })).then(next => {
        const joined = next.join('|');
        if (stamp && stamp !== joined) emit({ type: 'resources-changed' });
        stamp = joined;
      }).catch(() => undefined).finally(() => { inFlight = false; });
    }, 30_000); this.resourcesTimer.unref();
  }
  async configure(input: PiPreferences): Promise<PiEnvironment> {
    if (this.backend.runs().length) throw new Error('请先断开所有桌面会话再修改连接配置。');
    if (!input || typeof input !== 'object') throw new Error('配置无效');
    for (const key of ['executable', 'agentDir'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('路径必须为字符串');
    if (input.sessionDirs !== undefined && (!Array.isArray(input.sessionDirs) || input.sessionDirs.length > 20 || input.sessionDirs.some(p => typeof p !== 'string' || !p.trim()))) throw new Error('额外会话目录无效');
    if (input.runtime !== undefined && !['auto','bundled','system','custom'].includes(input.runtime)) throw new Error('无效运行时类型');
    if(input.runtime==='custom' && !input.executable?.trim()) throw new Error('请填写自定义 pi 路径');
    this.preferences = { runtime:input.runtime, executable: input.executable?.trim() || undefined, agentDir: input.agentDir?.trim() || undefined, sessionDirs: input.sessionDirs?.map(expand) };
    fs.mkdirSync(this.dataDir, { recursive: true });
    const target = path.join(this.dataDir, 'pi-desktop.json');
    // 合并磁盘最新文档：pi-desktop.json 还承载 packages/codemode 等期望记录，
    // 整包重写会把 repair 真理源抹掉。损坏文档绝不覆盖（只有 ENOENT 视为空）——
    // 让 configure 失败报错，比静默吞掉用户配置安全。
    let persisted: Record<string, unknown> = {};
    if (fs.existsSync(target)) {
      let parsed: unknown;
      try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); }
      catch (e) { throw new Error(`pi-desktop.json 损坏，请手动修复后再改连接配置：${e instanceof Error ? e.message : e}`); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('pi-desktop.json 损坏，请手动修复后再改连接配置');
      persisted = parsed as Record<string, unknown>;
    }
    fs.writeFileSync(target + '.tmp', JSON.stringify({ ...persisted, ...this.preferences }, null, 2), { mode: 0o600 }); fs.renameSync(target + '.tmp', target);
    this.accounts.dispose(); this.backend.dispose(); this.index.close();
    this.environment = this.withAppVersion(discoverPi(this.preferences));
    this.index = this.createIndex();
    this.usage = new UsageStatsService(() => this.index.usageStatsAsync());
    this.backend = new PiBackend(this.environment, this.index, ownedRootOf(this.environment), this.policyPath, this.emit, this.dataDir);
    this.sidecar = new SidecarService(this.backend, this.index, this.dataDir, this.emit);
    void this.index.start(() => this.emit({ type: 'sessions-changed' }));
    // P1-4：新 client 的镜像为空，渲染层 configure 返回后立即 reloadSessions——必须等
    // 首个快照就绪再返回并广播，reloadSessions 拿到的才是真实列表，侧栏不清空。（client
    // 在首个快照上也会经 changed 触发一次广播，这里再发一次是幂等的双保险；handle(
    // 'configure') 经统一入口透传 Promise，调用方 await 不变。）
    await this.index.ready();
    this.emit({ type: 'sessions-changed' });
    return this.environment;
  }
  /** 会话索引住在 utility process（见 index-worker-entry）；roots/owned/agentDir 与
   *  outline 缓存路径随环境一起下发。非 Electron 进程（vitest）里 utilityTransport
   *  自动退到同一 runtime 的进程内承载，不是另一套实现。 */
  private createIndex(): IndexPort {
    const owned = path.join(this.environment.agentDir, 'sessions', 'desktop');
    return new IndexWorkerClient(
      { roots: [...new Set([...this.environment.sessionDirs, owned])], ownedRoot: owned, agentDir: this.environment.agentDir, outlineCachePath: path.join(this.dataDir, 'outline-cache.json'), metaCachePath: path.join(this.dataDir, 'session-meta.json') },
      cfg => utilityTransport(cfg, workerEntryPath()),
    );
  }
  /** 首个 sessions IPC 等镜像快照；窗口创建不等待此 Promise（冷扫期间显示加载态）。 */
  ready(): Promise<void> { return this.index.ready(); }
  /** Re-discover the pi runtime after an upgrade, without changing saved preferences. */
  refreshEnvironment(): PiEnvironment {
    this.environment = this.withAppVersion(discoverPi(this.preferences));
    return this.environment;
  }
  /** 注入 Desktop 应用版本（discoverPi 不持有 electron app 引用）。 */
  private withAppVersion(env: PiEnvironment): PiEnvironment { if (this.appVersion) env.desktopVersion = this.appVersion; return env; }
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
    // Provider 适配层：native 目录 + 静态文件之外，把扩展 registerProvider 的运行时模型
    // （get_available_models，任一活跃会话即权威快照）并入目录——不落盘的扩展 provider 只有这条通道可见。
    const runtimeModels = runtimeModelsFromRuns(this.backend.runs());
    const packages = this.settingsPackages();
    try {
      const native=await this.accounts.catalog();
      // Read local configuration AFTER the worker returns: a concurrent save must win.
      return mergeRuntimeProviders(mergeModelCatalog(readModelCatalog(this.environment.agentDir), native), runtimeModels, packages);
    }catch(e){
      const catalog=mergeRuntimeProviders(readModelCatalog(this.environment.agentDir), runtimeModels, packages);
      catalog.warning=e instanceof Error?e.message:String(e);
      return catalog;
    }
  }
  /** settings.json packages（字符串/{source} 双形态，扩展来源徽标推断用）。 */
  private settingsPackages(): string[] {
    try {
      return packagesFromSettings(JSON.parse(fs.readFileSync(path.join(this.environment.agentDir, 'settings.json'), 'utf8')));
    } catch { return []; }
  }
  modelDefaultSave(input: { provider?: string; model?: string }) { return writeDefaultModel(this.environment.agentDir, input); }
  /** Persistence succeeds independently of connected-session adoption; never claim both on failure. */
  private async adoptModelConfiguration(catalog: import('../../shared/pi').PiModelCatalog) {
    const sessionRefresh = await this.backend.refreshModelConfiguration();
    return { ...catalog, sessionRefresh, ...(sessionRefresh.failed ? { warning: '配置已保存，但部分会话刷新失败；请检查会话提示，修复后刷新模型列表或断开后重连。' } : {}) };
  }
  modelProviderSave(provider: PiModelProviderDraft) { return this.adoptModelConfiguration(writeModelProvider(this.environment.agentDir, provider)); }
  modelProviderAuthSave(input: { id: string; apiKey?: string; clear?: boolean }) { return this.adoptModelConfiguration(writeProviderApiKey(this.environment.agentDir, input)); }
  modelProviderRemove(id: string) { return this.adoptModelConfiguration(removeModelProvider(this.environment.agentDir, id)); }
  /** 查询提供商 /models 清单（主进程发起避 CORS）；不落盘，结果交渲染层填入表单。 */
  modelProviderFetchModels(input: { id?: string; baseUrl?: string; apiKey?: string }) { return fetchProviderModels(this.environment.agentDir, input); }
  usageStats() { return this.usage.get(); }
  review(cwd: string) {
    if (!this.index.scan().some(s => s.cwd === cwd) && !this.backend.runs().some(r => r.cwd === cwd)) throw new Error('请先选择该项目的会话');
    return workspaceReview(cwd);
  }
  dispose() { this.accounts.dispose(); clearInterval(this.resourcesTimer); this.index.close(); this.backend.dispose(); }
}

function ownedRootOf(env: PiEnvironment): string {
  // 保持与 createIndex() 相同的 owned 派生口径（backend 的 ownedRoot 必须与索引一致）。
  return path.join(env.agentDir, 'sessions', 'desktop');
}
