// Builds the Windows installers into release/.
//   node scripts/package.mjs [--arch universal|x64|arm64] [--publish never|always]
// "universal" (default) is one installer with x64 and ARM64 that picks the right one.
// Updates come from github.com/<GH_OWNER>/sap-adt-mcp releases (GH_OWNER defaults to GustavoHMM;
// CI sets it from the repository owner, so forks publish and update from their own releases).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build, Platform, Arch } from 'electron-builder';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { values } = parseArgs({ options: { arch: { type: 'string', default: 'universal' }, publish: { type: 'string', default: 'never' } } });
const archs = values.arch === 'universal' ? ['x64', 'arm64'] : [values.arch];
for (const a of archs) if (!['x64', 'arm64'].includes(a)) throw new Error(`unsupported arch ${a}`);
const run = (script, args = []) => execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], { stdio: 'inherit' });

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pkgVersion = (name) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
const electronVersion = pkgVersion('electron');

// 1. Everything the installer carries.
if (!fs.existsSync(path.join(root, 'build', 'upstream', 'MANIFEST.json'))) run('build-upstream.mjs');
run('build-cli.mjs', ['--arch', values.arch === 'universal' ? 'all' : values.arch, '--out', 'build/cli-release']);
run('build-desktop.mjs');
run('notices.mjs');

// 2. A clean app folder: the bundles plus only the native modules (both architectures).
const stage = path.join(root, 'build', 'app');
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(path.join(root, 'apps', 'desktop', 'out'), stage, { recursive: true });
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'abap-adt-mcp',
      productName: 'ABAP ADT MCP',
      version: rootPkg.version,
      description: 'Conecta o Claude ao SAP (ABAP ADT) / Connects Claude to SAP (ABAP ADT)',
      author: { name: 'Gustavo Maia', email: 'gustavo.hmm@gmail.com' },
      license: 'MIT',
      main: 'main.cjs',
      // Only the native modules: everything else is bundled into main.cjs and the renderer.
      // electron-builder ships declared dependencies only (with the platform packages present).
      dependencies: { '@napi-rs/keyring': pkgVersion('@napi-rs/keyring'), koffi: pkgVersion('koffi') },
    },
    null,
    2,
  ),
);
const nm = path.join(stage, 'node_modules');
for (const name of ['@napi-rs/keyring', 'koffi']) fs.cpSync(path.join(root, 'node_modules', name), path.join(nm, name), { recursive: true });
for (const arch of archs) {
  const natives = path.join(root, 'build', '.cache', `native-${arch}`, 'node_modules');
  for (const name of [`@napi-rs/keyring-win32-${arch}-msvc`, `@koromix/koffi-win32-${arch}`]) {
    fs.cpSync(path.join(natives, name), path.join(nm, name), { recursive: true });
  }
}

// 3. Installer.
const owner = process.env.GH_OWNER || 'GustavoHMM';
const resources = path.join(root, 'apps', 'desktop', 'build-resources');
const suffix = values.arch === 'universal' ? '' : '-${arch}';
const result = await build({
  targets: Platform.WINDOWS.createTarget('nsis', ...archs.map((a) => Arch[a])),
  publish: values.publish,
  config: {
    appId: 'com.gustavomaia.abapadtmcp',
    productName: 'ABAP ADT MCP',
    copyright: 'Copyright © 2026 Gustavo Maia',
    electronVersion,
    // The app speaks Portuguese and English; Chromium's other locales only add size.
    electronLanguages: ['pt-BR', 'en-US'],
    directories: { app: stage, output: path.join(root, 'release'), buildResources: resources },
    files: ['**/*'],
    asar: true,
    asarUnpack: ['node_modules/@napi-rs/**', 'node_modules/@koromix/**', 'node_modules/koffi/**'],
    npmRebuild: false,
    afterPack: (context) => verifyCli(context.appOutDir, Arch[context.arch]),
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    // electron-builder always drops a node_modules folder at the root of a resource set,
    // so the CLI's native modules (keyring, koffi) go in an entry of their own.
    extraResources: [
      { from: path.join(root, 'build', 'cli-release', 'win-${arch}'), to: 'cli' },
      { from: path.join(root, 'build', 'cli-release', 'win-${arch}', 'node_modules'), to: 'cli/node_modules' },
      { from: path.join(root, 'build', 'THIRD-PARTY-NOTICES.md'), to: 'THIRD-PARTY-NOTICES.md' },
      { from: path.join(root, 'LICENSE'), to: 'LICENSE.txt' },
    ],
    // Harden the packaged Electron: no "run as Node", no NODE_OPTIONS or inspector flags, asar integrity.
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    win: {
      icon: path.join(resources, 'icon.ico'),
      requestedExecutionLevel: 'asInvoker',
      signExts: ['.node'],
      signtoolOptions: { sign: path.join(root, 'scripts', 'sign.cjs') },
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: 'ABAP ADT MCP',
      deleteAppDataOnUninstall: false,
      installerIcon: path.join(resources, 'icon.ico'),
      uninstallerIcon: path.join(resources, 'icon.ico'),
      include: path.join(resources, 'installer.nsh'),
      artifactName: `ABAP-ADT-MCP-Setup-\${version}${suffix}.\${ext}`,
    },
    publish: owner ? [{ provider: 'github', owner, repo: 'sap-adt-mcp', releaseType: 'draft' }] : null,
  },
});
for (const file of result) console.log(`[package] ${path.relative(root, file)}`);

/**
 * Runs before the installer is made: the packed CLI must carry its native
 * modules, or Claude would get "Cannot find module" on every machine. When this
 * computer can run the exe, it also asks the exe itself.
 */
function verifyCli(appOutDir, arch) {
  const cli = path.join(appOutDir, 'resources', 'cli');
  const required = [
    'abap-adt-mcp.exe',
    'upstream/MANIFEST.json',
    'node_modules/@napi-rs/keyring/package.json',
    `node_modules/@napi-rs/keyring-win32-${arch}-msvc/keyring.win32-${arch}-msvc.node`,
    'node_modules/koffi/package.json',
    `node_modules/@koromix/koffi-win32-${arch}/package.json`,
  ];
  const absent = required.filter((f) => !fs.existsSync(path.join(cli, f)));
  if (absent.length) throw new Error(`[package] ${arch}: CLI incomplete, missing ${absent.join(', ')}`);
  // Windows on ARM also runs x64; an x64 machine cannot run the ARM64 exe.
  if (arch !== process.arch && !(process.arch === 'arm64' && arch === 'x64')) {
    console.log(`[package] ${arch}: CLI files present (exe not run on ${process.arch})`);
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abap-adt-mcp-verify-'));
  try {
    const out = execFileSync(path.join(cli, 'abap-adt-mcp.exe'), ['version', '--json'], { env: { ...process.env, ABAP_ADT_MCP_HOME: home }, encoding: 'utf8' });
    const info = JSON.parse(out);
    if (!Array.isArray(info.missingComponents) || info.missingComponents.length) {
      throw new Error(`[package] ${arch}: the packed CLI cannot load ${info.missingComponents ?? 'its components'}`);
    }
    console.log(`[package] ${arch}: CLI ${info.version} loads all native components`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
