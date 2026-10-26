import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopApi, NavigateTarget, TestEvent, UpdateStatus } from '../shared/api.ts';

// The only bridge between the page and the main process: a fixed list of calls.
const api: DesktopApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  setLanguage: (lang) => ipcRenderer.invoke('app:setLanguage', lang),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  suggestProfileId: (environment, client) => ipcRenderer.invoke('profiles:suggestId', environment, client),
  normalizeUrl: (text) => ipcRenderer.invoke('url:normalize', text),
  saveProfile: (request) => ipcRenderer.invoke('profiles:save', request),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  setPassword: (id, password) => ipcRenderer.invoke('profiles:setPassword', id, password),
  trustCertificate: (id, pem, fingerprint) => ipcRenderer.invoke('profiles:trustCertificate', id, pem, fingerprint),
  startTest: (id) => ipcRenderer.invoke('test:start', id),
  cancelTest: (runId) => ipcRenderer.invoke('test:cancel', runId),
  onTestEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: TestEvent) => listener(payload);
    ipcRenderer.on('test:event', handler);
    return () => ipcRenderer.removeListener('test:event', handler);
  },
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  connectClaude: (profileId, kind, confirmation) => ipcRenderer.invoke('claude:connect', profileId, kind, confirmation),
  disconnectClaude: (profileId, kind) => ipcRenderer.invoke('claude:disconnect', profileId, kind),
  restartClaudeDesktop: () => ipcRenderer.invoke('claude:restart'),
  restoreClaudeBackup: (kind) => ipcRenderer.invoke('claude:restore', kind),
  openClaudeDownload: () => ipcRenderer.invoke('claude:download'),
  usageInstructions: (profileId) => ipcRenderer.invoke('claude:usage', profileId),
  setDisabledTools: (profileId, tools) => ipcRenderer.invoke('profiles:setTools', profileId, tools),
  onNavigate: (listener) => {
    const handler = (_event: IpcRendererEvent, target: NavigateTarget) => listener(target);
    ipcRenderer.on('app:navigate', handler);
    return () => ipcRenderer.removeListener('app:navigate', handler);
  },
  updateStatus: () => ipcRenderer.invoke('update:status'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  getStartWithWindows: () => ipcRenderer.invoke('app:getStartWithWindows'),
  setStartWithWindows: (enabled) => ipcRenderer.invoke('app:setStartWithWindows', enabled),
  openNotices: () => ipcRenderer.invoke('app:openNotices'),
  createDiagnostics: () => ipcRenderer.invoke('app:diagnostics'),
};

contextBridge.exposeInMainWorld('api', api);
