import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/api.ts';

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Checks GitHub Releases at start and every six hours, downloads in the
 * background (through Windows proxy settings, via Chromium) and installs on
 * quit or when the person clicks "update now". Profiles and Claude connections
 * live outside the install folder, so nothing is lost.
 */
export function startUpdater(notify: (status: UpdateStatus) => void): { installNow: () => void; check: () => void } {
  let last: UpdateStatus = { state: 'idle' };
  const set = (status: UpdateStatus) => {
    last = status;
    notify(status);
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'none' }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', version: last.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (e) => set({ state: 'error', message: String(e?.message ?? e).slice(0, 200) }));
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, SIX_HOURS).unref();
  return { installNow: () => autoUpdater.quitAndInstall(true, true), check };
}
