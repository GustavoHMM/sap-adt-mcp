import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { tempHome } from './helpers/fixtures.ts';
import { buildManifest, verifyUpstream, manifestHash } from '../src/integrity.ts';
import { claudeStatus, connectProfile, removeOwnedEntries, repairOwnedEntries } from '../src/claude/integration.ts';
import { currentDir, deployRuntime, isOurExecutable, removeRuntime, runtimeRoot, stableExe } from '../src/runtime.ts';
import type { Profile } from '../src/profiles.ts';

let home: string;
const source = (version: string, withNative = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abap-cli-'));
  fs.writeFileSync(path.join(dir, 'abap-adt-mcp.exe'), `exe ${version}`);
  fs.mkdirSync(path.join(dir, 'upstream'));
  fs.writeFileSync(path.join(dir, 'upstream', 'index.js'), 'x');
  if (withNative) {
    fs.mkdirSync(path.join(dir, 'node_modules', 'koffi'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'koffi', 'index.js'), 'native');
  }
  return dir;
};
const currentFolder = () => path.basename(fs.readlinkSync(currentDir()));

before(() => {
  home = tempHome();
});

test('installing copies the server to runtime\\<version>-<fingerprint> and points runtime\\current at it', () => {
  const r = deployRuntime(source('0.1.0'), '0.1.0');
  assert.equal(r.switched, true);
  assert.match(currentFolder(), /^0\.1\.0-[0-9a-f]{8}$/);
  assert.equal(r.exe, path.join(home, 'runtime', 'current', 'abap-adt-mcp.exe'));
  assert.equal(fs.readFileSync(stableExe(), 'utf8'), 'exe 0.1.0');
  assert.equal(deployRuntime(source('0.1.0'), '0.1.0').switched, false, 'same version: nothing to do');
});

test('an update switches the junction; versions still in use are kept, others removed', () => {
  const old = currentFolder();
  const busy = (dir: string) => path.basename(dir) === old;
  const r = deployRuntime(source('0.2.0'), '0.2.0', busy);
  assert.equal(r.switched, true);
  assert.equal(fs.readFileSync(stableExe(), 'utf8'), 'exe 0.2.0');
  assert.ok(fs.existsSync(path.join(runtimeRoot(), old)), 'a Claude session still runs 0.1.0');
  const r2 = deployRuntime(source('0.2.0'), '0.2.0');
  assert.deepEqual(r2.removedOld, [old]);
  assert.match(currentFolder(), /^0\.2\.0-/);
});

test('a fixed package of the same version gets its own folder, even while the broken copy runs', () => {
  deployRuntime(source('0.3.0', false), '0.3.0');
  const broken = currentFolder();
  assert.ok(!fs.existsSync(path.join(runtimeRoot(), broken, 'node_modules')));
  const r = deployRuntime(source('0.3.0'), '0.3.0', (dir) => path.basename(dir) === broken);
  assert.equal(r.switched, true);
  assert.notEqual(currentFolder(), broken);
  assert.ok(fs.existsSync(path.join(runtimeRoot(), currentFolder(), 'node_modules', 'koffi', 'index.js')));
  assert.ok(fs.existsSync(path.join(runtimeRoot(), broken)), 'kept while a Claude session runs it');
});

test('only executables under the runtime or our install folder count as ours', () => {
  assert.equal(isOurExecutable(stableExe()), true);
  assert.equal(isOurExecutable('C:\\Users\\x\\AppData\\Local\\Programs\\ABAP ADT MCP\\resources\\cli\\abap-adt-mcp.exe', ['C:\\Users\\x\\AppData\\Local\\Programs\\ABAP ADT MCP']), true);
  assert.equal(isOurExecutable('C:\\Projetos\\abap-adt-mcp\\build\\cli\\win-arm64\\abap-adt-mcp.exe'), false);
});

test('the upstream files are checked against the manifest baked into the exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abap-upstream-'));
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(buildManifest(dir)));
  const expected = manifestHash(dir);
  assert.deepEqual(verifyUpstream(dir, expected), { ok: true, checked: 2 });
  assert.deepEqual(verifyUpstream(dir, undefined), { ok: true, checked: 0 }, 'development: no baked hash');
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'console.log(2)');
  assert.deepEqual(verifyUpstream(dir, expected), { ok: false, problem: 'changed dist/index.js' });
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(buildManifest(dir)));
  assert.deepEqual(verifyUpstream(dir, expected), { ok: false, problem: 'manifest changed' }, 'a re-generated manifest is not trusted');
});

test('after an install moves the exe, only our own Claude entries are repaired; uninstall removes only ours', async () => {
  const local = process.env.LOCALAPPDATA!;
  fs.mkdirSync(path.join(local, 'Packages', 'Claude_rt1'), { recursive: true });
  fs.mkdirSync(path.join(local, 'Claude-Data', 'claude_rt1'), { recursive: true });
  const cfg = path.join(local, 'Claude-Data', 'claude_rt1', 'claude_desktop_config.json');
  fs.writeFileSync(cfg, '{}');
  const env = { ...process.env, ABAP_ADT_MCP_CLAUDE_CLI: 'none' };
  const qas: Profile = { id: 'QAS400', name: 'QAS', url: 'https://sap', client: '400', username: 'U', environment: 'QAS' };
  const dev: Profile = { ...qas, id: 'DEV100', name: 'DEV', client: '100', environment: 'DEV' };
  const oldInstall = 'C:\\Users\\x\\AppData\\Local\\Programs\\ABAP ADT MCP\\resources\\cli\\abap-adt-mcp.exe';
  await connectProfile(qas, 'desktop', { command: oldInstall, args: [] }, { env });
  await connectProfile(dev, 'desktop', { command: 'C:\\Projetos\\abap-adt-mcp\\build\\cli\\win-arm64\\abap-adt-mcp.exe', args: [] }, { env });

  const server = { command: stableExe(), args: [] };
  const isOurs = (c: string) => isOurExecutable(c, ['C:\\Users\\x\\AppData\\Local\\Programs\\ABAP ADT MCP']);
  const repair = await repairOwnedEntries([qas, dev], server, isOurs, env);
  assert.deepEqual(repair.repaired, [{ profileId: 'QAS400', kind: 'desktop' }]);
  const status = claudeStatus([qas, dev], server, env);
  assert.equal(status.profiles.QAS400?.desktop.state, 'connected');
  assert.equal(status.profiles.DEV100?.desktop.state, 'outdated', 'a hand-made dev registration is left alone');

  assert.equal(await removeOwnedEntries(isOurs, env), 1);
  const servers = JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['abap-adt-DEV100']);
});

test('the runtime folder can be removed on uninstall', () => {
  removeRuntime();
  assert.equal(fs.existsSync(runtimeRoot()), false);
});
