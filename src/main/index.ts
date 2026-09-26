import { enableOfficialSubagent, officialSubagentStatus, recoverSubagents, cleanupSubagents } from './pi/official-subagent';
import { listMemoryFiles, memoryAssistStatus, readMemoryFileContent, detectMemoryPlugin, builtinMemoryDir, DEFAULT_MEMORY_SOURCE } from './pi/memory-bridge';
import { TerminalService } from './pi/terminal-service';
import { filePreview } from './pi/file-preview';
import { gitStatus } from './pi/git-status';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { AutomationService } from './pi/automation-service';
import { importAttachments, clipboardAttachments, readAttachment, downloadImage } from './pi/attachments';
import { createProjectWorktree } from './pi/project-worktree';
import { openMemoryFile } from './pi/memory-open';
import { authorizeProjectCwd, listExternalApps, openWithApp } from './pi/open-with';
import { canonical, fileKey } from './pi/session-index';
import { bundleIcon } from './pi/app-icon';
import { SessionArchive } from './pi/session-archive';
import { autoArchiveKeys } from './pi/auto-archive';
import { autoDeleteArchivedKeys, deleteArchivedSession } from './pi/auto-delete';
import { projectFiles, projectContext, readContext, projectBranch, skillChoices } from './pi/composer-service';
import { isAccessMode } from '../shared/access-mode';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import { SettingsService } from './pi/settings-service';
import { VoiceService } from './pi/voice-service';
import { PiHost } from './pi/host';
import { RemoteServer } from './pi/remote-server';
import { ImBot } from './pi/im-bot';
import { createBotActions } from './pi/bot/actions';
import type { PiEvent } from '../shared/pi';

const APP_ICON = path.join(app.getAppPath(), 'resources/icon.png');
const remote = new RemoteServer({
  sessions: () => host.index.scan(),
  runs: () => host.backend.runs(),
  history: key => {
    try { return host.index.history(key); } catch { return null; }
  },
  version: () => host.environment.version,
  // 写操作直转 backend：与桌面 IPC 同一套校验（会话连接、generation、可发送状态）。
  prompt: (key, text) => host.backend.prompt(key, text, 'followUp'),
  stop: key => host.backend.stop(key),
  respond: (key, generation, response) => host.backend.respond(key, generation, response),
  pendingDialogs: key => host.backend.pendingDialogs(key),
});
const imBot = new ImBot(path.join(app.getPath('userData'), 'im-bot.json'), undefined, () => {
  if (!host || !settings) throw new Error('pi 尚未就绪');
  return createBotActions(host, settings);
});

let mainWindow: BrowserWindow | null = null;
let host: PiHost;
let settings: SettingsService;
let archive: SessionArchive;
let automations: AutomationService | undefined;
let terminals: TerminalService;
let voice: VoiceService;
function broadcast(event: PiEvent) {
  automations?.onPiEvent(event);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('local-pi:event', event);
  remote.publish(event);
  void imBot.onPiEvent(event, key => {
    try {
      const run = host.backend.runs().find(r => r.key === key);
      const session = host.index.scan().find(s => s.key === key);
      return session?.name ?? run?.cwd.split(/[\\/]/).at(-1) ?? '会话';
    } catch {
      return '会话';
    }
  });
}
function registerIpc() {
  // 旧 string[] 索引迁移时仅扫描一次；缺失文件由 SessionArchive 回退到迁移当下时间。
  let migrationUpdatedAt: Map<string, number> | undefined;
  archive = new SessionArchive(path.join(app.getPath('userData'), 'archived-sessions.json'), key => {
    migrationUpdatedAt ??= new Map(host.index.scan().map(s => [s.key, s.updatedAt]));
    return migrationUpdatedAt.get(key);
  });
  // 内置终端：pty 事件广播到渲染进程（批量后的数据 + 退出通知）。终端 IPC 处理器在下方 handle 定义后注册。
  terminals = new TerminalService(event => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event.type === 'terminalData' ? 'local-pi:terminalData' : 'local-pi:terminalExit', event);
  });
  const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(`local-pi:${name}`, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('非法 IPC 来源');
    return fn(...args);
  });
  handle('automationSnapshot',()=>automations!.snapshot());
  handle('terminalCreate', input => terminals.create(input ?? {}));
  handle('terminalWrite', (id, data) => terminals.write(id, data));
  handle('terminalResize', (id, cols, rows) => terminals.resize(id, cols, rows));
  handle('terminalKill', id => terminals.kill(id));
  handle('automationSaveTask',input=>automations!.saveTask(input));
  handle('automationDeleteTask',id=>automations!.deleteTask(id));
  handle('automationToggle',id=>automations!.toggle(id));
  handle('automationRunTask',id=>automations!.runTask(id));
  handle('automationSaveWorkflow',input=>automations!.saveWorkflow(input));
  handle('automationDeleteWorkflow',id=>automations!.deleteWorkflow(id));
  handle('automationRunWorkflow',input=>automations!.runWorkflow(input));
  handle('automationStop',id=>automations!.stop(id));
  handle('automationExport',async id=>{
    const workflow=automations!.snapshot().workflows.find(w=>w.id===id);if(!workflow)throw Error('工作流不存在');
    const result=await dialog.showSaveDialog(mainWindow!,{defaultPath:'workflow.pi.json',filters:[{name:'PI 工作流',extensions:['json']}]});
    if(result.canceled||!result.filePath)return false;
    await fs.writeFile(result.filePath,JSON.stringify({format:'pi-desktop-workflow-v1',workflow},null,2),'utf8');return true;
  });
  handle('automationImport',async()=>{
    const result=await dialog.showOpenDialog(mainWindow!,{properties:['openFile'],filters:[{name:'PI 工作流',extensions:['json']}]});
    if(result.canceled)return null;const file=result.filePaths[0];if((await fs.stat(file)).size>2*1024*1024)throw Error('工作流文件过大');
    const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.format!=='pi-desktop-workflow-v1')throw Error('请选择 PI Desktop 工作流文件，ZCode 脚本需要转换为 pi 步骤');
    return automations!.saveWorkflow({...data.workflow,id:'',scope:'global',cwd:''});
  });
  handle('settingsSnapshot', cwd => settings.snapshot(cwd));
  handle('saveDesktopSettings', patch => {
    settings.savePreferences(patch);
    // 归档/自动删除相关设置保存后立刻扫描一次，否则最长要等 30 分钟定时器才生效。
    if (patch && typeof patch === 'object' && ('autoArchive' in patch || 'archiveRetentionDays' in patch || 'autoDeleteArchived' in patch || 'autoDeleteArchivedDays' in patch)) setTimeout(archiveCleanupPass, 200);
  });
  handle('saveAiSettings', value => settings.saveAi(value));
  handle('resourceRead', (id, cwd) => settings.readResource(id, cwd));
  handle('resourceSave', input => settings.saveResource(input));
  handle('resourceCreate', input => settings.createResource(input));
  handle('resourceToggle', (id, enabled, cwd) => settings.toggleResource(id, enabled, cwd));
  handle('revealResource', (id, cwd) => shell.showItemInFolder(settings.resourcePath(id, cwd)));
  handle('mcpSave', input => settings.mcpSave(input));
  handle('mcpTest', (id, cwd) => settings.mcpTest(id, cwd));
  handle('projectSave', value => settings.projectSave(value));
  const knownProject = (cwd:string) => {
    if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('项目路径无效');
    const real=canonical(cwd);
    if(![...settings.preferences().projects.map(p=>p.path),...host.index.scan().map(s=>s.cwd)].some(p=>canonical(p)===real))throw new Error('项目不存在，请刷新。');
    return real;
  };
  handle('projectReveal', cwd => shell.showItemInFolder(knownProject(cwd)));
  handle('projectWorktree', async value => {
    knownProject(value?.projectPath);
    const project=await createProjectWorktree(value);
    try{settings.projectSave(project);}catch{throw new Error(`工作树已创建于 ${project.path}，但未能添加到 Desktop，请手动添加该目录。`);}
    return project;
  });
  handle('projectArchive', cwd => {
    const real=knownProject(cwd);
    const runs=host.backend.runs().filter(r=>canonical(r.cwd)===real);
    if(runs.some(r=>r.status!=='idle'||r.pending>0||host.backend.hasPendingDialogs(r.key)))throw new Error('项目中有运行或等待确认的任务，请先停止后归档。');
    const keys=[...new Set([...host.index.scan().filter(s=>canonical(s.cwd)===real).map(s=>s.key),...runs.map(r=>r.key)])];
    const result=archive.setMany(keys,true);broadcast({type:'sessions-changed'});return result;
  });
  handle('runSubagent', (id, cwd, task, parentKey) => settings.runSubagent(id, cwd, task, parentKey));
  handle('importSession', async () => {
    const chosen = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'pi session', extensions: ['jsonl'] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const result = settings.importFile(chosen.filePaths[0]); broadcast({ type: 'sessions-changed' }); return result;
  });
  handle('environment', () => host.environment);
  handle('configure', value => host.configure(value));
  handle('refreshEnvironment', () => host.refreshEnvironment());
  handle('upgradeLocalPi', () => host.upgradeLocalPi());
  handle('archivedSessions', () => archive.list());
  handle('setSessionArchived', (key, archived) => {
    const run = host.backend.runs().find(r=>r.key===key);
    if(archived && !host.index.scan().some(s=>s.key===key) && !run) throw new Error('会话不存在，请刷新列表。');
    const result = archive.set(key, archived, !!run && (run.status!=='idle' || run.pending>0 || host.backend.hasPendingDialogs(key)));
    broadcast({type:'sessions-changed'});
    return result;
  });
  // 手动删除归档会话：文件移到系统废纸篓（可恢复）；文件已不存在时只清理索引条目。
  handle('deleteArchivedSession', async key => {
    const result = await deleteArchivedSession({
      key, archive, sessions: host.index.scan(), runs: host.backend.runs(),
      hasPendingDialogs: k => host.backend.hasPendingDialogs(k),
      trash: file => shell.trashItem(file), exists: file => fsSync.existsSync(file), keyOf: fileKey,
    });
    broadcast({ type: 'sessions-changed' });
    return result;
  });
  handle('sessions', () => host.index.scan());
  handle('history', (key, leaf) => host.index.history(key, leaf));
  handle('resources', cwd => host.resources(cwd));
  handle('connect', input => {
    if (!input || typeof input.trustProject !== 'boolean' || !isAccessMode(input.permission)) throw new Error('连接参数无效');
    return host.backend.connect(input);
  });
  handle('setAccessMode', (key, mode) => host.backend.setAccessMode(key, mode));
  handle('runs', () => host.backend.runs());
  handle('prompt', (key, text, behavior, images) => { if (typeof text !== 'string' || !['steer', 'followUp'].includes(behavior)) throw new Error('输入无效'); return host.backend.prompt(key, text, behavior, images); });
  handle('compact', (key, customInstructions) => { if (customInstructions !== undefined && typeof customInstructions !== 'string') throw new Error('输入无效'); return host.backend.compact(key, customInstructions || undefined); });
  handle('stop', key => host.backend.stop(key));
  handle('queueEdit', (key, op) => {
    if (!op || typeof op !== 'object' || !['remove', 'edit', 'now'].includes((op as { type?: string }).type ?? '')) throw new Error('队列操作无效');
    return host.backend.queueEdit(key, op);
  });
  handle('packageList', () => host.packageList());
  handle('packageSearch', q => { if (typeof q !== 'string' || q.length > 100) throw new Error('搜索词无效'); return host.packageSearch(q); });
  handle('packageCovers', names => {
    if (!Array.isArray(names) || names.length > 64 || names.some(n => typeof n !== 'string' || n.length > 214)) throw new Error('包名列表无效');
    return host.packageCovers(names);
  });
  handle('packageInstall', (source, action) => {
    if (typeof source !== 'string' || !['install', 'remove'].includes(action)) throw new Error('包操作无效');
    return host.packageInstall(source, action);
  });
  handle('packageRegister', spec => { if (typeof spec !== 'string') throw new Error('包来源无效'); return host.packageRegister(spec); });
  handle('close', key => host.backend.close(key));
  handle('refresh', key => host.backend.refresh(key));
  handle('model', (key, provider, id) => host.backend.model(key, provider, id));
  handle('respond', (key, generation, response) => host.backend.respond(key, generation, response));
  handle('forkMessage', (key, entryId) => host.backend.forkTo(key, entryId));
  handle('review', cwd => host.review(cwd));
  handle('gitStatus', cwd => gitStatus(cwd));
  handle('filePreview', (cwd, file) => filePreview(cwd, file));
  handle('officialSubagentStatus', () => officialSubagentStatus(host.environment.agentDir));
  handle('enableOfficialSubagent', () => enableOfficialSubagent(host.environment.agentDir));
  handle('recoverSubagents', (key: string) => recoverSubagents(host.environment.agentDir, key));
  handle('cleanupSubagents', (key: string) => cleanupSubagents(host.environment.agentDir, key));
  // 记忆衔接层：探测 CLI 记忆插件（如 pi-memory），未启用时回退 Desktop 内置桥
  handle('memoryAssistStatus', (enabled: unknown) => memoryAssistStatus(host.environment.agentDir, Boolean(enabled)));
  handle('memoryList', (cwd: unknown) => listMemoryFiles(host.environment.agentDir, typeof cwd === 'string' && cwd ? cwd : undefined));
  handle('memoryRead', (rel: unknown, cwd: unknown) => readMemoryFileContent(host.environment.agentDir, String(rel), typeof cwd === 'string' && cwd ? cwd : undefined));
  // 一键启用内置默认记忆插件：已装未登记 → 补注册；未装 → pi install 后注册。
  handle('memoryEnableDefault', async () => {
    const detected = detectMemoryPlugin(host.environment.agentDir);
    if (detected.kind === 'extension') return { installed: true, registered: true };
    const nodeFs = await import('node:fs');
    const onDisk = nodeFs.existsSync(path.join(host.environment.agentDir, 'npm', 'node_modules', 'pi-memory'));
    if (!onDisk) await host.packageInstall(DEFAULT_MEMORY_SOURCE, 'install');
    await host.packageRegister(DEFAULT_MEMORY_SOURCE);
    return { installed: true, registered: true };
  });
  handle('modelCatalog', () => host.modelCatalog());
  handle('accountLogin', provider => host.accounts.start(provider));
  handle('accountStatus', id => host.accounts.status(id));
  handle('accountAnswer', (id,promptId,value) => host.accounts.answer(id,promptId,value));
  handle('accountCancel', id => host.accounts.cancel(id));
  handle('accountOpen', id => shell.openExternal(host.accounts.url(id)));
  handle('planQuota', provider => host.accounts.quota(String(provider)));
  handle('modelDefaultSave', input => host.modelDefaultSave(input));
  handle('modelProviderSave', draft => host.modelProviderSave(draft));
  handle('modelProviderRemove', id => host.modelProviderRemove(id));
  handle('usageStats', () => host.usageStats());
  handle('revealPath', p => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('路径无效');
    shell.showItemInFolder(p);
  });
  // 外部应用打开当前项目：真实系统图标（best effort），白名单探测 + argv 启动。
  // app.getFileIcon 在 macOS 26 对 .app 一律返回通用占位图，优先走 bundle 内 icns 提取。
  const fileIcon = async (p: string) => {
    const bundled = await bundleIcon(p);
    if (bundled) return bundled;
    try { const icon = await app.getFileIcon(p, { size: 'normal' }); return icon.isEmpty() ? undefined : icon.toDataURL(); } catch { return undefined; }
  };
  handle('externalApps', () => listExternalApps({ fileIcon }));
  handle('memoryOpen', (rel, cwd, appId) => openMemoryFile(host.environment.agentDir, rel, cwd, appId,
    [...settings.preferences().projects.map(p => p.path), ...host.index.scan().map(s => s.cwd), ...host.backend.runs().map(r => r.cwd)],
    { reveal: file => shell.showItemInFolder(file) }));
  handle('openWith', (cwd, appId) => {
    const known = [...settings.preferences().projects.map(p => p.path), ...host.index.scan().map(s => s.cwd), ...host.backend.runs().map(r => r.cwd)];
    const real = authorizeProjectCwd(cwd, known);
    return openWithApp(real, appId, {
      openPath: async target => { const failed = await shell.openPath(target); if (failed) throw new Error(failed); },
    });
  });
  handle('remoteStart', () => remote.start());
  handle('remoteStop', () => remote.stop());
  handle('remoteStatus', () => remote.status());
  handle('imConfig', () => imBot.current);
  handle('imSave', patch => imBot.save(patch));
  handle('imTest', () => imBot.send('PI Desktop 通知测试：配置成功 ✅'));
  handle('composerSkills', cwd => skillChoices(settings.resources(cwd)));
  // 语音输入：ASR 模型列表（密钥只留主进程）+ 云端转写。
  voice = new VoiceService(() => app.getPath('userData'));
  handle('voiceConfig', () => voice.config());
  handle('voiceSaveModel', input => voice.saveModel(input ?? {}));
  handle('voiceRemoveModel', id => voice.removeModel(String(id)));
  handle('voiceSetActive', id => voice.setActive(String(id)));
  handle('voiceTranscribe', (bytes, mime) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('录音数据格式无效');
    if (typeof mime !== 'string' || mime.length > 100) throw new Error('音频类型无效');
    return voice.transcribe(bytes, mime);
  });
  handle('projectFiles', cwd => projectFiles(cwd));
  handle('projectContext', (cwd, relative) => projectContext(cwd, relative));
  handle('projectBranch', cwd => projectBranch(cwd));
  handle('thinking', (key, level) => host.backend.thinking(key, level));
  handle('importAttachments', files => importAttachments(files));
  handle('clipboardAttachments', () => clipboardAttachments());
  handle('downloadImage', (name, dataUrl) => downloadImage(name, dataUrl));
  handle('pickDocuments', async () => {
    const chosen = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'], filters: [{name:'文档与文本',extensions:['png','jpg','jpeg','webp','gif','pdf','docx','txt','md','csv','json','yaml','yml','log','ts','tsx','js','py']},{name:'所有文件',extensions:['*']}] });
    if(chosen.canceled) return [];
    if(chosen.filePaths.length > 10) throw new Error('一次最多添加 10 个文档。');
    return Promise.all(chosen.filePaths.map(file => readAttachment(file)));
  });
  handle('pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
}

function autoArchivePass() {
  if (!archive || !settings || !host) return;
  try {
    const alreadyArchived = new Set(archive.list());
    const keys = autoArchiveKeys({ preferences: settings.preferences(), sessions: host.index.scan(), runs: host.backend.runs(), hasPendingDialogs: key => host.backend.hasPendingDialogs(key) })
      .filter(key => !alreadyArchived.has(key));
    if (keys.length) { archive.setMany(keys, true); broadcast({ type: 'sessions-changed' }); }
  } catch { /* 单次扫描失败不影响下次定时重试 */ }
}

/** 自动删除超期归档会话：永久删除（fs.unlink，不进废纸篓）。单条失败不影响其它。 */
function autoDeletePass() {
  if (!archive || !settings || !host) return;
  try {
    const preferences = settings.preferences();
    if (!preferences.autoDeleteArchived) return;
    const sessions = host.index.scan();
    const keys = autoDeleteArchivedKeys({ preferences, entries: archive.entries(), sessions, runs: host.backend.runs(), hasPendingDialogs: key => host.backend.hasPendingDialogs(key) });
    if (!keys.length) return;
    const removed: string[] = [];
    for (const key of keys) {
      try {
        // 每条删除前重新检查索引、活跃连接与最后操作时间，避免扫描期间变动导致误删。
        const currentEntries = archive.entries();
        const currentSessions = host.index.scan();
        const currentPreferences = settings.preferences();
        if (!autoDeleteArchivedKeys({ preferences: currentPreferences, entries: currentEntries, sessions: currentSessions,
          runs: host.backend.runs(), hasPendingDialogs: k => host.backend.hasPendingDialogs(k) }).includes(key)) continue;
        const session = currentSessions.find(s => s.key === key)!;
        if (!session.path.endsWith('.jsonl') || fileKey(session.path) !== key) throw new Error('会话文件路径校验失败');
        try { fsSync.unlinkSync(session.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        archive.remove([key]);
        removed.push(key);
      } catch (error) {
        console.warn('[auto-delete] 删除归档会话失败，已跳过：', key, error);
      }
    }
    if (removed.length) {
      console.log(`[auto-delete] 已永久删除 ${removed.length} 个超期归档会话`);
      broadcast({ type: 'sessions-changed' });
    }
  } catch (error) { console.warn('[auto-delete] 本轮扫描失败，下次重试：', error); }
}

function archiveCleanupPass() {
  autoArchivePass(); // 先归档：新归档条目的 archivedAt 记为当前时间，不会立刻被删除
  autoDeletePass();
}

// -- window ---------------------------------------------------------------------

function createWindow(): void {
  if(!process.env.PI_SMOKE)automations?.start();
  // 语音输入（getUserMedia）无需安装权限 handler：Electron 未设置 handler 时默认放行，
  // 麦克风授权由 macOS TCC（NSMicrophoneUsageDescription）在首次使用时提示。
  // 自定义 handler 反而会把剪贴板等现有能力一并接管，得不偿失。
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'PI Desktop',
    icon: nativeImage.createFromPath(APP_ICON),
    backgroundColor: '#11141a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 工作台内置浏览器（BrowserPanel）使用 <webview>。guest 的导航/弹窗限制见下方
      // web-contents-created 守卫；webview 本身不挂 preload，任意网页拿不到 window.localPi。
      webviewTag: true,
    },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Project Repository',
            click: () => shell.openExternal('https://github.com/vastsa/PI-Desktop'),
          },
        ],
      },
    ]),
  );

  const devUrl = process.env.PI_VITE_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', event => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// -- lifecycle ---------------------------------------------------------------
app.setName('PI Desktop');
// 内置浏览器（工作台 browser tab 的 <webview> guest）安全边界：
// - 仅允许 http/https 导航；file:、javascript:、data: 等协议一律拦截
//   （渲染层 normalizeUrl 先行拦截，这里兜底防页面内跳转绕过）；
// - 外链（target=_blank / window.open）一律 deny 并转交系统默认浏览器，
//   绝不新建可能带 node 权限的 Electron 窗口。
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
});
if (process.env.PI_DESKTOP_DATA_DIR) app.setPath('userData', path.resolve(process.env.PI_DESKTOP_DATA_DIR));
// One scheduler per data directory; opening the app again focuses the existing window.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance',()=>{if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}else if(host)createWindow();});
void app.whenReady().then(() => {
  if(!primaryInstance)return;
  const policy = app.isPackaged ? path.join(process.resourcesPath, 'desktop-policy/index.mjs') : path.join(app.getAppPath(), 'extensions/desktop-policy/index.mjs');
  host = new PiHost(app.getPath('userData'), policy, broadcast, process.env.PI_SMOKE_SETTINGS ? path.join(app.getPath('userData'), 'shared-skills') : undefined);
  settings = new SettingsService(host, app.getPath('userData'), path.dirname(policy));
  // 记忆衔接：launch 时现取 memoryAssist 开关与生效记忆插件目录（desktop-memory 扩展由此注入）。
  host.backend.memoryOptions = () => ({
    enabled: settings.preferences().memoryAssist === true,
    dir: builtinMemoryDir(host.environment.agentDir),
  });
  automations = new AutomationService(path.join(app.getPath('userData'),'automations.json'),()=>host.backend,()=>{
    if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('local-pi:automations-changed');
  });
  registerIpc();
  if(!process.env.PI_SMOKE)automations.start();
  setTimeout(archiveCleanupPass, 15_000).unref(); // 启动后先扫一次
  setInterval(archiveCleanupPass, 30 * 60 * 1000).unref(); // 每 30 分钟定时扫描
  void imBot.syncTransport().catch(() => undefined); // resume a configured two-way bot
  // Dev mode runs from the default Electron bundle, so the Dock/⌘Tab icon must
  // be set explicitly; a packaged build takes the icon from icon.icns instead.
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(APP_ICON);
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
  if (process.env.PI_SMOKE === '1') {
    console.log('[smoke] pi host booted; version:', host.environment.version, 'sessions:', host.index.scan().length);
    host.dispose(); app.exit(0); return;
  }
  createWindow();
  if (process.env.PI_SMOKE === '2') {
    const win = mainWindow!;
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('[renderer]', message); });
    win.webContents.on('did-fail-load', (_e, code, desc) => { console.error(code, desc); app.exit(1); });
    win.webContents.on('did-finish-load', async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 1200));
        if (process.env.PI_SMOKE_CLICK) {
          for (const selector of process.env.PI_SMOKE_CLICK.split('||')) {
            await win.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(selector)})?.click(); true`,
            );
            await new Promise(resolve => setTimeout(resolve, 600));
          }
        }
        if (process.env.PI_SMOKE_SETTINGS === '1') {
          const { settingsSmoke } = await import('./pi/settings-smoke');
          console.log('[settings-smoke]', JSON.stringify(await settingsSmoke(win, process.env.PI_SMOKE_OUTPUT || path.join(app.getPath('userData'), 'settings-smoke'))));
        }
        if (process.env.PI_SMOKE_EXECUTION === '1') {
          const { executionSmoke } = await import('./pi/execution-smoke');
          console.log('[execution-smoke]', JSON.stringify(await executionSmoke(win, process.env.PI_SMOKE_OUTPUT || path.join(app.getPath('userData'), 'execution-smoke'))));
        }
        const result = await win.webContents.executeJavaScript(`(() => {
          const back = document.querySelector('.pi-settings__back');
          const r = back && back.getBoundingClientRect();
          const send = document.querySelector('.pi-composer__send');
          const ss = send && getComputedStyle(send);
          const scard = document.querySelector('.pi-shortcuts');
          return { title: document.title, ready: !!document.querySelector('[data-pi-ready]'), text: document.body.innerText.slice(0, 1400),
            backRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
            send: ss ? { radius: ss.borderRadius, w: ss.width, h: ss.height, bg: ss.backgroundColor, disabled: send.disabled } : null,
            pills: [...document.querySelectorAll('.pi-composer__pill')].map(p => p.textContent.trim()).slice(0, 6),
            shortcuts: scard ? {
              rows: scard.querySelectorAll('tbody tr').length,
              headers: [...scard.querySelectorAll('th')].map(th => th.textContent.trim()),
              firstKeys: [...scard.querySelectorAll('tbody tr')][0] ? [...(scard.querySelectorAll('tbody tr')[0].querySelectorAll('.pi-kbd'))].map(k => k.textContent) : [],
              footButtons: [...scard.querySelectorAll('.pi-shortcuts__foot button, .pi-shortcuts__ops button')].length
            } : null,
            bot: (() => {
              const form = document.querySelector('.pi-providerform');
              return {
                channels: [...document.querySelectorAll('.pi-remote__channelname')].map(c => c.textContent.trim()),
                formFields: form ? [...form.querySelectorAll('label > span')].map(l => l.textContent.trim()) : [],
                hasTwoWay: !!document.querySelector('.pi-remote__channel--on'),
              };
            })(),
            inlineEdit: 'disabled-probe' };
        })()`);
        console.log('[smoke2]', JSON.stringify(result));
        if (process.env.PI_SMOKE_SCREENSHOT) {
          const fs = await import('node:fs');
          fs.writeFileSync(process.env.PI_SMOKE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
        }
        if (process.env.PI_SMOKE_REMOTE) {
          const status = await remote.start(Number(process.env.PI_SMOKE_REMOTE) || 0);
          console.log('[remote]', JSON.stringify(status));
          await new Promise(resolve => setTimeout(resolve, 12000)); // keep the viewer reachable for curl checks
        }
        host.dispose(); app.exit(result.ready ? 0 : 1);
      } catch (err) { console.error(err); host.dispose(); app.exit(1); }
    });
    setTimeout(() => { host.dispose(); app.exit(1); }, process.env.PI_SMOKE_SETTINGS || process.env.PI_SMOKE_REMOTE ? 60000 : 20000).unref();
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => {
  automations?.dispose();
  host?.dispose();
  terminals?.dispose();
  void remote.stop();
  void imBot.stopTransport();
});
app.on('window-all-closed', () => { host?.accounts.dispose(); automations?.suspend(); host?.backend.dispose(); if (process.platform !== 'darwin') app.quit(); });
