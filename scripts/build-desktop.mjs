// Builds the Electron app into apps/desktop/out: main.cjs, preload.cjs and renderer/.
//   node scripts/build-desktop.mjs [--run]    (--run starts the app afterwards)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const desktop = path.join(root, 'apps', 'desktop');
const out = path.join(desktop, 'out');
const { values } = parseArgs({ options: { run: { type: 'boolean', default: false } } });
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// npm 11 skips install scripts in workspaces; fetch the Electron binary when missing.
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) {
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });
}

fs.rmSync(out, { recursive: true, force: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
  define: { __APP_VERSION__: JSON.stringify(appVersion), 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
};
await esbuild.build({
  ...common,
  entryPoints: [path.join(desktop, 'src', 'main', 'main.ts')],
  outfile: path.join(out, 'main.cjs'),
  external: ['electron', '@napi-rs/keyring', 'koffi'],
});
// A sandboxed preload may only require "electron": no banner, no Node built-ins.
await esbuild.build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
  entryPoints: [path.join(desktop, 'src', 'preload', 'preload.ts')],
  outfile: path.join(out, 'preload.cjs'),
  external: ['electron'],
});
await viteBuild({ configFile: path.join(desktop, 'vite.config.ts'), logLevel: 'warn' });
console.log('[desktop] built apps/desktop/out');

if (values.run) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExe, [desktop], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
}
