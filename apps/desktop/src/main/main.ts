import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, ipcMain, Menu, session, type IpcMainInvokeEvent } from 'electron';
import { defaultSapLanguage, langFromLocale, type Lang } from '@abap-adt-mcp/core/messages';
import { suggestProfileId, loadProfiles, type Environment } from '@abap-adt-mcp/core/profiles';
import { loadSettings, saveSettings } from '@abap-adt-mcp/core/settings';
import { APP_VERSION } from '@abap-adt-mcp/core/version';
import type { AppInfo, SaveProfileRequest, TestEvent } from '../shared/api.ts';
import { cliVersion, locateCli, runCliTest, type RunningTest } from './cli.ts';
import {
  deleteProfileEverywhere,
  listProfileViews,
  normalizeUrlView,
  saveProfileRequest,
  setProfilePassword,
  trustCertificateFor,
} from './services.ts';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rendererFile = path.join(__dirname, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;

app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
const runningTests = new Map<string, RunningTest>();

function systemLocale(): string {
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale() ?? 'en';
}

function currentLang(): Lang {
  const forced = process.env.ABAP_ADT_MCP_LANG;
  if (forced === 'pt' || forced === 'en') return forced;
  return loadSettings().language ?? langFromLocale(systemLocale());
}

const cli = () => locateCli({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot });
const cliEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ABAP_ADT_MCP_LANG: currentLang() });

/** Only our own page may call the main process. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (event.senderFrame?.url !== rendererUrl) throw new Error('unexpected sender');
    return fn(...(args as A));
  });
}

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
  });
  handle('profiles:list', () => listProfileViews());
  handle('profiles:suggestId', (env: Environment, client: string) => suggestProfileId(env, client, loadProfiles().map((p) => p.id)));
  handle('url:normalize', (text: string) => normalizeUrlView(String(text ?? ''), currentLang()));
  handle('profiles:save', (request: SaveProfileRequest) => saveProfileRequest(request));
  handle('profiles:delete', (id: string) => deleteProfileEverywhere(String(id)));
  handle('profiles:setPassword', (id: string, password: string) => setProfilePassword(String(id), String(password)));
  handle('profiles:trustCertificate', (id: string, pem: string, fingerprint: string) => trustCertificateFor(String(id), String(pem), String(fingerprint)));
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
  mainWindow.on('closed', () => {
    for (const run of runningTests.values()) run.cancel();
    mainWindow = null;
  });
  void mainWindow.loadFile(rendererFile);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  registerIpc();
  createWindow();
});
