// Builds the pinned upstream (vendor/mcp-abap-adt) without changing its code, then
// stages a production copy in build/upstream with UPSTREAM-INFO.json and its LICENSE.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const vendor = path.join(root, 'vendor', 'mcp-abap-adt');
const stage = path.join(root, 'build', 'upstream');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

if (!fs.existsSync(path.join(vendor, 'package.json'))) {
  throw new Error('vendor/mcp-abap-adt is empty: run "git submodule update --init"');
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vendor, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: vendor, encoding: 'utf8' }).trim();
if (dirty) throw new Error(`the upstream working tree has local changes; it must stay untouched:\n${dirty}`);

console.log(`[upstream] building ${commit}`);
run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], vendor);
run(npm, ['run', 'build'], vendor);

console.log('[upstream] staging production copy');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'README.md']) {
  fs.copyFileSync(path.join(vendor, file), path.join(stage, file));
}
fs.cpSync(path.join(vendor, 'dist'), path.join(stage, 'dist'), { recursive: true });
run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
fs.rmSync(path.join(stage, 'package-lock.json'));

const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
const info = { name: pkg.name, version: pkg.version, commit, repository: 'https://github.com/mario-andreschak/mcp-abap-adt', license: pkg.license };
fs.writeFileSync(path.join(stage, 'UPSTREAM-INFO.json'), JSON.stringify(info, null, 2) + '\n');
if (fs.existsSync(path.join(stage, '.env'))) throw new Error('a .env file must never be packaged');
console.log(`[upstream] ready: ${pkg.name} ${pkg.version} (${commit.slice(0, 7)}) in build/upstream`);
