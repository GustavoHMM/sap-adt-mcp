import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron';
import { claudeStatus, connectProfile, disconnectProfile, repairOwnedEntries, restoreBackup, type ClientKind, type ServerCommand } from '@abap-adt-mcp/core/claude/integration';
import { detectClaudeDesktop } from '@abap-adt-mcp/core/claude/desktop';
import { listProcesses } from '@abap-adt-mcp/core/claude/processes';
import { restartClaudeDesktop } from '@abap-adt-mcp/core/claude/restart';
import { createLogger } from '@abap-adt-mcp/core/log';
import { defaultSapLanguage, langFromLocale, t, type Lang } from '@abap-adt-mcp/core/messages';
import { effectiveDisabledTools, getProfile, loadProfiles, suggestProfileId, type Environment } from '@abap-adt-mcp/core/profiles';
import { deployRuntime, isOurExecutable, stableExe } from '@abap-adt-mcp/core/runtime';
import { loadSettings, saveSettings } from '@abap-adt-mcp/core/settings';
import { usageInstructions } from '@abap-adt-mcp/core/tools';
import { APP_VERSION } from '@abap-adt-mcp/core/version';
import type { AppInfo, NavigateTarget, SaveProfileRequest, TestEvent, UpdateStatus } from '../shared/api.ts';
import { cliVersion, locateCli, runCliDiagnostics, runCliTest, type RunningTest } from './cli.ts';
import {
  deleteProfileEverywhere,
  listProfileViews,
  normalizeUrlView,
  saveProfileRequest,
  setDisabledTools,
  setProfilePassword,
  trustCertificateFor,
} from './services.ts';
import { createTray } from './tray.ts';
import { startUpdater } from './updater.ts';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rendererFile = path.join(__dirname, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
const CLAUDE_DOWNLOAD = 'https://claude.ai/download';
const startHidden = process.argv.includes('--hidden');
const log = createLogger('app');

app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let trayHintShown = false;
let tray: ReturnType<typeof createTray> | null = null;
let updateState: UpdateStatus = { state: 'disabled' };
let updater: ReturnType<typeof startUpdater> | null = null;
const runningTests = new Map<string, RunningTest>();

function systemLocale(): string {
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale() ?? 'en';
}

function currentLang(): Lang {
  const forced = process.env.ABAP_ADT_MCP_LANG;
  if (forced === 'pt' || forced === 'en') return forced;
  return loadSettings().language ?? langFromLocale(systemLocale());
}

/** The executable the connection test runs (the copy shipped with the app, or the dev build). */
const cli = () => locateCli({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot });
const cliEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ABAP_ADT_MCP_LANG: currentLang() });

/** What Claude configs point to: the stable runtime\current path once installed, the dev build otherwise. */
const claudeServer = (): ServerCommand => (app.isPackaged ? { command: stableExe(), args: [] } : cli());
const installDir = () => path.dirname(process.execPath);
const noticesFile = () => (app.isPackaged ? path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES.md') : path.join(repoRoot, 'build', 'THIRD-PARTY-NOTICES.md'));

/** A runtime version folder is in use while some process runs an exe from it (a Claude session). */
function folderInUse(dir: string): boolean {
  const prefix = path.resolve(dir).toLowerCase() + path.sep;
  try {
    return listProcesses().some((p) => p.path?.toLowerCase().startsWith(prefix));
  } catch {
    return true;
  }
}

/** Installed app: copy this version's server to runtime\<version>, switch "current", fix our entries. */
async function prepareRuntime(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const deployed = deployRuntime(path.join(process.resourcesPath, 'cli'), APP_VERSION, folderInUse);
    const repair = await repairOwnedEntries(loadProfiles(), claudeServer(), (cmd) => isOurExecutable(cmd, [installDir()]));
    log.info('runtime', { version: deployed.version, switched: deployed.switched, removedOld: deployed.removedOld, repaired: repair.repaired });
  } catch (e) {
    log.error('runtime-failed', { error: (e as Error).message });
  }
}

/** Only our own page may call the main process. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (event.senderFrame?.url !== rendererUrl) throw new Error('unexpected sender');
    return fn(...(args as A));
  });
}

const asKind = (kind: unknown): ClientKind => {
  if (kind !== 'desktop' && kind !== 'code') throw new Error('unknown Claude client');
  return kind;
};

function registerIpc(): void {
  handle('app:info', async (): Promise<AppInfo> => {
    const saved = loadSettings().language ?? null;
    return {
      version: APP_VERSION,
      lang: currentLang(),
      langSetting: saved,
      sapLanguage: defaultSapLanguage(systemLocale()),
      arch: process.arch,
      cli: await cliVersion(cli(), cliEnv()),
    };
  });
  handle('app:setLanguage', (lang: Lang | null) => {
    const settings = loadSettings();
    if (lang === 'pt' || lang === 'en') settings.language = lang;
    else delete settings.language;
    saveSettings(settings);
    tray?.refresh();
  });
  handle('app:getStartWithWindows', () => app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin);
  handle('app:setStartWithWindows', (enabled: unknown) => app.setLoginItemSettings({ openAtLogin: enabled === true, args: ['--hidden'] }));
  handle('app:openNotices', async () => {
    await shell.openPath(noticesFile());
  });
  handle('app:diagnostics', async () => {
    const lang = currentLang();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const choice = await dialog.showSaveDialog(mainWindow!, {
      title: lang === 'pt' ? 'Salvar pacote de diagnóstico' : 'Save diagnostics package',
      defaultPath: path.join(app.getPath('desktop'), `abap-adt-mcp-diagnostico-${stamp}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (choice.canceled || !choice.filePath) return { ok: false as const, canceled: true };
    const result = await runCliDiagnostics(cli(), cliEnv(), choice.filePath);
    if (result.ok) shell.showItemInFolder(choice.filePath);
    return { ...result, file: choice.filePath };
  });
  handle('update:status', () => updateState);
  handle('update:install', () => {
    if (updateState.state === 'ready') {
      quitting = true;
      updater?.installNow();
    }
  });
  handle('profiles:list', () => listProfileViews());
  handle('profiles:suggestId', (env: Environment, client: string) => suggestProfileId(env, client, loadProfiles().map((p) => p.id)));
  handle('url:normalize', (text: string) => normalizeUrlView(String(text ?? ''), currentLang()));
  handle('profiles:save', (request: SaveProfileRequest) => {
    const result = saveProfileRequest(request);
    tray?.refresh();
    return result;
  });
  handle('profiles:delete', async (id: string) => {
    await deleteProfileEverywhere(String(id));
    tray?.refresh();
  });
  handle('profiles:setPassword', (id: string, password: string) => setProfilePassword(String(id), String(password)));
  handle('profiles:trustCertificate', (id: string, pem: string, fingerprint: string) => trustCertificateFor(String(id), String(pem), String(fingerprint)));
  handle('profiles:setTools', (id: string, tools: unknown) => setDisabledTools(String(id), tools));
  handle('test:start', (id: string) => {
    const emit = (event: TestEvent) => {
      if (event.kind === 'done' || event.kind === 'error') runningTests.delete(event.runId);
      mainWindow?.webContents.send('test:event', event);
    };
    const run = runCliTest(cli(), String(id), cliEnv(), emit);
    runningTests.set(run.runId, run);
    return run.runId;
  });
  handle('test:cancel', (runId: string) => runningTests.get(String(runId))?.cancel());
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text)));

  handle('claude:status', () => claudeStatus(loadProfiles(), claudeServer()));
  handle('claude:connect', async (id: string, kind: unknown, confirmation: unknown) => {
    const profile = getProfile(String(id));
    if (!profile) throw new Error('unknown profile');
    return connectProfile(profile, asKind(kind), claudeServer(), { confirmation: typeof confirmation === 'string' ? confirmation : undefined });
  });
  handle('claude:disconnect', (id: string, kind: unknown) => disconnectProfile(String(id), asKind(kind)));
  handle('claude:restart', async () => {
    const install = detectClaudeDesktop();
    if (!install) return { ok: false as const, reason: 'not-installed' as const };
    return restartClaudeDesktop(install);
  });
  handle('claude:restore', (kind: unknown) => restoreBackup(asKind(kind)));
  handle('claude:download', () => shell.openExternal(CLAUDE_DOWNLOAD));
  handle('claude:usage', (id: string) => {
    const profile = getProfile(String(id));
    if (!profile) throw new Error('unknown profile');
    return usageInstructions(profile, effectiveDisabledTools(profile), currentLang());
  });
}

function showWindow(target?: NavigateTarget): void {
  if (!mainWindow) createWindow(true);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (target) mainWindow.webContents.send('app:navigate', target);
}

function createWindow(visible: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    title: 'ABAP ADT MCP',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.ABAP_ADT_MCP_DEVTOOLS === '1',
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  if (visible) mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Closing the window keeps the app in the tray; "Quit" in the tray really exits.
  mainWindow.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    mainWindow?.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      const lang = currentLang();
      tray.tray.displayBalloon({ title: t(lang, 'tray.hiddenTitle'), content: t(lang, 'tray.hiddenBody') });
    }
  });
  mainWindow.on('closed', () => {
    for (const run of runningTests.values()) run.cancel();
    mainWindow = null;
  });
  void mainWindow.loadFile(rendererFile);
}

app.on('second-instance', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  await prepareRuntime();
  registerIpc();
  tray = createTray({
    iconPath: path.join(__dirname, 'tray.png'),
    show: showWindow,
    quit: () => {
      quitting = true;
      app.quit();
    },
    lang: currentLang,
  });
  // "Start with Windows" launches with --hidden: tray only, the window opens on demand.
  createWindow(!startHidden);
  if (app.isPackaged && process.env.ABAP_ADT_MCP_NO_UPDATES !== '1') {
    updater = startUpdater((status) => {
      updateState = status;
      mainWindow?.webContents.send('update:status', status);
    });
  }
});
