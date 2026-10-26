import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron';
import { claudeStatus, connectProfile, disconnectProfile, restoreBackup, type ClientKind } from '@abap-adt-mcp/core/claude/integration';
import { detectClaudeDesktop } from '@abap-adt-mcp/core/claude/desktop';
import { restartClaudeDesktop } from '@abap-adt-mcp/core/claude/restart';
import { defaultSapLanguage, langFromLocale, t, type Lang } from '@abap-adt-mcp/core/messages';
import { effectiveDisabledTools, getProfile, loadProfiles, suggestProfileId, type Environment } from '@abap-adt-mcp/core/profiles';
import { loadSettings, saveSettings } from '@abap-adt-mcp/core/settings';
import { usageInstructions } from '@abap-adt-mcp/core/tools';
import { APP_VERSION } from '@abap-adt-mcp/core/version';
import type { AppInfo, NavigateTarget, SaveProfileRequest, TestEvent } from '../shared/api.ts';
import { cliVersion, locateCli, runCliTest, type RunningTest } from './cli.ts';
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

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rendererFile = path.join(__dirname, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
const CLAUDE_DOWNLOAD = 'https://claude.ai/download';

app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let trayHintShown = false;
let tray: ReturnType<typeof createTray> | null = null;
const runningTests = new Map<string, RunningTest>();

function systemLocale(): string {
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale() ?? 'en';
}

function currentLang(): Lang {
  const forced = process.env.ABAP_ADT_MCP_LANG;
  if (forced === 'pt' || forced === 'en') return forced;
  return loadSettings().language ?? langFromLocale(systemLocale());
}

/** The same executable runs the connection test and is what Claude configs point to. */
const cli = () => locateCli({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot });
const cliEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ABAP_ADT_MCP_LANG: currentLang() });

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

  handle('claude:status', () => claudeStatus(loadProfiles(), cli()));
  handle('claude:connect', async (id: string, kind: unknown, confirmation: unknown) => {
    const profile = getProfile(String(id));
    if (!profile) throw new Error('unknown profile');
    return connectProfile(profile, asKind(kind), cli(), { confirmation: typeof confirmation === 'string' ? confirmation : undefined });
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
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (target) mainWindow.webContents.send('app:navigate', target);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    title: 'ABAP ADT MCP',
    show: false,
    autoHideMenuBar: true,
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
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

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  registerIpc();
  tray = createTray({
    show: showWindow,
    quit: () => {
      quitting = true;
      app.quit();
    },
    lang: currentLang,
  });
  createWindow();
});
