import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PiApi, UserChoice } from '../shared/api';
import type { AppEvent } from '../shared/types';

/**
 * Typed, minimal bridge. The renderer sees `window.pi` and nothing else —
 * no Node integration, no remote content.
 */

const api: PiApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),

  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  listDir: (dir) => ipcRenderer.invoke('fs:listDir', dir),

  listProjects: () => ipcRenderer.invoke('projects:list'),
  addProject: (p) => ipcRenderer.invoke('projects:add', p),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),

  listSessions: (projectId) => ipcRenderer.invoke('sessions:list', projectId),
  createSession: (projectId, opts) => ipcRenderer.invoke('sessions:create', projectId, opts),
  loadSession: (projectId, sessionId) => ipcRenderer.invoke('sessions:load', projectId, sessionId),
  updateSession: (projectId, sessionId, patch) => ipcRenderer.invoke('sessions:update', projectId, sessionId, patch),
  approvePlan: (projectId, sessionId) => ipcRenderer.invoke('sessions:approvePlan', projectId, sessionId),
  deleteSession: (projectId, sessionId) => ipcRenderer.invoke('sessions:delete', projectId, sessionId),
  sessionChanges: (projectId, sessionId) => ipcRenderer.invoke('sessions:changes', projectId, sessionId),

  sendPrompt: (sessionId, text) => ipcRenderer.invoke('agent:send', sessionId, text),
  interrupt: (sessionId) => ipcRenderer.invoke('agent:interrupt', sessionId),
  status: (sessionId) => ipcRenderer.invoke('agent:status', sessionId),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  saveProvider: (input) => ipcRenderer.invoke('providers:save', input),
  deleteProvider: (id) => ipcRenderer.invoke('providers:delete', id),

  respondPermission: (requestId, choice: UserChoice) => ipcRenderer.invoke('permission:respond', requestId, choice),

  onEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, event: AppEvent) => cb(event);
    ipcRenderer.on('pi:event', handler);
    return () => ipcRenderer.off('pi:event', handler);
  },
};

contextBridge.exposeInMainWorld('pi', api);

// pi-backed desktop API. Legacy bridge remains for source compatibility only.
import type { LocalPiApi, PiEvent } from '../shared/pi';
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`local-pi:${name}`, ...args);
const localPi: LocalPiApi = {
  projectReveal: cwd => invoke('projectReveal',cwd), projectWorktree: value => invoke('projectWorktree',value), projectArchive: cwd => invoke('projectArchive',cwd),
  archivedSessions: () => invoke('archivedSessions'), setSessionArchived: (key, archived) => invoke('setSessionArchived', key, archived),
  composerSkills: cwd => invoke('composerSkills', cwd),
  projectFiles: cwd => invoke('projectFiles', cwd), projectContext: (cwd, relative) => invoke('projectContext', cwd, relative),
  automationSnapshot: () => invoke('automationSnapshot'),
  automationSaveTask: input => invoke('automationSaveTask',input), automationDeleteTask:id=>invoke('automationDeleteTask',id),
  automationToggle:id=>invoke('automationToggle',id), automationRunTask:id=>invoke('automationRunTask',id),
  automationSaveWorkflow:input=>invoke('automationSaveWorkflow',input), automationDeleteWorkflow:id=>invoke('automationDeleteWorkflow',id),
  automationRunWorkflow:input=>invoke('automationRunWorkflow',input), automationStop:id=>invoke('automationStop',id),
  automationExport:id=>invoke('automationExport',id), automationImport:()=>invoke('automationImport'),
  onAutomationChanged:listener=>{ipcRenderer.on('local-pi:automations-changed',listener);return()=>ipcRenderer.removeListener('local-pi:automations-changed',listener);},
  importAttachments: files => invoke('importAttachments', files), clipboardAttachments: () => invoke('clipboardAttachments'), downloadImage: (name, dataUrl) => invoke('downloadImage', name, dataUrl),
  pickDocuments: () => invoke('pickDocuments'), projectBranch: cwd => invoke('projectBranch', cwd),
  thinking: (key, level) => invoke('thinking', key, level),
  settingsSnapshot: cwd => invoke('settingsSnapshot', cwd),
  saveDesktopSettings: patch => invoke('saveDesktopSettings', patch), saveAiSettings: value => invoke('saveAiSettings', value),
  resourceRead: (id, cwd) => invoke('resourceRead', id, cwd), resourceSave: input => invoke('resourceSave', input),
  resourceCreate: input => invoke('resourceCreate', input), resourceToggle: (id, enabled, cwd) => invoke('resourceToggle', id, enabled, cwd),
  revealResource: (id, cwd) => invoke('revealResource', id, cwd), mcpSave: input => invoke('mcpSave', input),
  mcpTest: (id, cwd) => invoke('mcpTest', id, cwd), projectSave: value => invoke('projectSave', value),
  importSession: () => invoke('importSession'), runSubagent: (id, cwd, task, parentKey) => invoke('runSubagent', id, cwd, task, parentKey),
  environment: () => invoke('environment'), configure: value => invoke('configure', value),
  refreshEnvironment: () => invoke('refreshEnvironment'), upgradeLocalPi: () => invoke('upgradeLocalPi'),
  sessions: () => invoke('sessions'), history: (key, leaf) => invoke('history', key, leaf),
  resources: cwd => invoke('resources', cwd), connect: input => invoke('connect', input),
  runs: () => invoke('runs'), prompt: (key, text, behavior, images) => invoke('prompt', key, text, behavior, images),
  stop: key => invoke('stop', key), queueEdit: (key, op) => invoke('queueEdit', key, op), close: key => invoke('close', key), refresh: key => invoke('refresh', key),
  packageList: () => invoke('packageList'), packageSearch: q => invoke('packageSearch', q),
  packageCovers: names => invoke('packageCovers', names),
  packageInstall: (source, action) => invoke('packageInstall', source, action), packageRegister: spec => invoke('packageRegister', spec),
  setAccessMode: (key, mode) => invoke('setAccessMode', key, mode),
  model: (key, provider, id) => invoke('model', key, provider, id),
  respond: (key, gen, response) => invoke('respond', key, gen, response), forkMessage: (key, entryId) => invoke('forkMessage', key, entryId), review: cwd => invoke('review', cwd), gitStatus: cwd => invoke('gitStatus', cwd), filePreview: (cwd, file) => invoke('filePreview', cwd, file),
  officialSubagentStatus: () => invoke('officialSubagentStatus'),
  enableOfficialSubagent: () => invoke('enableOfficialSubagent'),
  recoverSubagents: (key: string) => invoke('recoverSubagents', key),
  memoryAssistStatus: (enabled: boolean) => invoke('memoryAssistStatus', enabled),
  memoryList: (cwd?: string) => invoke('memoryList', cwd),
  memoryRead: (rel: string) => invoke('memoryRead', rel),
  memoryEnableDefault: () => invoke('memoryEnableDefault'),
  cleanupSubagents: (key: string) => invoke('cleanupSubagents', key),
  modelCatalog: () => invoke('modelCatalog'),
  planQuota: provider => invoke('planQuota', provider),
  accountLogin: provider => invoke('accountLogin',provider),
  accountStatus: id => invoke('accountStatus',id),
  accountAnswer: (id,promptId,value) => invoke('accountAnswer',id,promptId,value),
  accountCancel: id => invoke('accountCancel',id),
  accountOpen: id => invoke('accountOpen',id),
  modelDefaultSave: input => invoke('modelDefaultSave', input),
  modelProviderSave: draft => invoke('modelProviderSave', draft),
  modelProviderRemove: id => invoke('modelProviderRemove', id),
  usageStats: () => invoke('usageStats'),
  remoteStart: () => invoke('remoteStart'), remoteStop: () => invoke('remoteStop'), remoteStatus: () => invoke('remoteStatus'),
  imConfig: () => invoke('imConfig'), imSave: patch => invoke('imSave', patch), imTest: () => invoke('imTest'),
  pickDirectory: () => invoke('pickDirectory'),
  revealPath: p => invoke('revealPath', p),
  externalApps: () => invoke('externalApps'), openWith: (cwd, appId) => invoke('openWith', cwd, appId),
  terminalCreate: input => invoke('terminalCreate', input),
  terminalWrite: (id, data) => invoke('terminalWrite', id, data),
  terminalResize: (id, cols, rows) => invoke('terminalResize', id, cols, rows),
  terminalKill: id => invoke('terminalKill', id),
  onTerminalData: listener => { const handler = (_e: IpcRendererEvent, event: TerminalDataEvent) => listener(event); ipcRenderer.on('local-pi:terminalData', handler); return () => ipcRenderer.removeListener('local-pi:terminalData', handler); },
  onTerminalExit: listener => { const handler = (_e: IpcRendererEvent, event: TerminalExitEvent) => listener(event); ipcRenderer.on('local-pi:terminalExit', handler); return () => ipcRenderer.removeListener('local-pi:terminalExit', handler); },
  onEvent: callback => { const listener = (_e: IpcRendererEvent, value: PiEvent) => callback(value); ipcRenderer.on('local-pi:event', listener); return () => ipcRenderer.off('local-pi:event', listener); },
};
contextBridge.exposeInMainWorld('localPi', localPi);
