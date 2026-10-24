// Builds abap-adt-mcp.exe (Node single executable application) for win-x64 and/or win-arm64.
//   node scripts/build-cli.mjs [--arch x64|arm64|all]     (default: this machine's arch)
// Output: build/cli/win-<arch>/ with the exe, its native modules and the upstream server.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

/** Official Node.js LTS embedded in the exe. Update together with .node-version. */
const NODE_VERSION = 'v24.22.1';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cache = path.join(root, 'build', '.cache');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const { values } = parseArgs({ options: { arch: { type: 'string', default: process.arch } } });
const arches = values.arch === 'all' ? ['x64', 'arm64'] : [values.arch];
for (const a of arches) if (!['x64', 'arm64'].includes(a)) throw new Error(`unsupported arch ${a}`);

const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const pkgVersion = (name) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

if (!fs.existsSync(path.join(root, 'build', 'upstream', 'UPSTREAM-INFO.json'))) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-upstream.mjs')], { stdio: 'inherit' });
}

// 1. One CommonJS bundle for every arch. Native modules stay outside, next to the exe.
const bundleDir = path.join(root, 'build', 'cli-bundle');
fs.rmSync(bundleDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(root, 'apps', 'cli', 'src', 'main.ts')],
  outfile: path.join(bundleDir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['@napi-rs/keyring', 'koffi'],
  define: { __APP_VERSION__: JSON.stringify(appVersion), 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  legalComments: 'external',
  logLevel: 'warning',
});
fs.writeFileSync(
  path.join(bundleDir, 'sea-config.json'),
  JSON.stringify({ main: 'main.cjs', output: 'sea-prep.blob', disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }),
);

// 2. Official Node.js binaries, verified against the published SHA-256 list.
fs.mkdirSync(cache, { recursive: true });
async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${dest}.part`, dest);
}
const sumsFile = path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sumsFile);
const sums = fs.readFileSync(sumsFile, 'utf8');
async function nodeExe(arch) {
  const name = `node-${NODE_VERSION}-win-${arch}`;
  const zip = path.join(cache, `${name}.zip`);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/${name}.zip`, zip);
  const expected = sums.split('\n').find((l) => l.trim().endsWith(`  ${name}.zip`))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${name}.zip`);
  if (!fs.existsSync(path.join(cache, name, 'node.exe'))) execFileSync('tar', ['-xf', zip, '-C', cache], { stdio: 'inherit' });
  return path.join(cache, name, 'node.exe');
}

// The blob does not depend on the arch (no code cache or snapshot); make it with a Node that runs here.
execFileSync(await nodeExe(process.arch), ['--experimental-sea-config', 'sea-config.json'], { cwd: bundleDir, stdio: 'inherit' });

// 3. Native modules for the target arch (N-API, prebuilt by their authors).
function nativePackages(arch) {
  const dir = path.join(cache, `native-${arch}`);
  const wanted = {
    [`@napi-rs/keyring-win32-${arch}-msvc`]: pkgVersion('@napi-rs/keyring'),
    [`@koromix/koffi-win32-${arch}`]: pkgVersion('koffi'),
  };
  const have = Object.entries(wanted).every(([n, v]) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', n, 'package.json'), 'utf8')).version === v;
    } catch {
      return false;
    }
  });
  if (!have) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
    execFileSync(npm, ['install', '--no-save', '--force', '--ignore-scripts', '--no-audit', '--no-fund', ...Object.entries(wanted).map(([n, v]) => `${n}@${v}`)], {
      cwd: dir,
      stdio: 'inherit',
      shell: true,
    });
  }
  return { dir: path.join(dir, 'node_modules'), names: Object.keys(wanted) };
}

for (const arch of arches) {
  const out = path.join(root, 'build', 'cli', `win-${arch}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const exe = path.join(out, 'abap-adt-mcp.exe');
  fs.copyFileSync(await nodeExe(arch), exe);
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', path.join(bundleDir, 'sea-prep.blob'), '--sentinel-fuse', SEA_FUSE],
    { stdio: 'pipe' },
  );

  const nm = path.join(out, 'node_modules');
  for (const name of ['@napi-rs/keyring', 'koffi']) fs.cpSync(path.join(root, 'node_modules', name), path.join(nm, name), { recursive: true });
  const natives = nativePackages(arch);
  for (const name of natives.names) fs.cpSync(path.join(natives.dir, name), path.join(nm, name), { recursive: true });

  fs.cpSync(path.join(root, 'build', 'upstream'), path.join(out, 'upstream'), { recursive: true });
  const legal = path.join(bundleDir, 'main.cjs.LEGAL.txt');
  if (fs.existsSync(legal)) fs.copyFileSync(legal, path.join(out, 'LEGAL-bundled.txt'));

  const size = (fs.statSync(exe).size / 1048576).toFixed(1);
  let smoke = '(not runnable on this machine)';
  if (arch === process.arch || (process.arch === 'arm64' && arch === 'x64')) {
    smoke = execFileSync(exe, ['version'], { encoding: 'utf8', env: { ...process.env, ABAP_ADT_MCP_LANG: 'en' } }).trim();
  }
  console.log(`[cli] win-${arch}: ${exe} (${size} MB)\n      ${smoke}`);
}
console.log('[cli] note: the exe is not code-signed yet (internal testing only).');
