import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopApi, TestEvent } from '../shared/api.ts';

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
};

contextBridge.exposeInMainWorld('api', api);
