import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { tempHome } from './helpers/fixtures.ts';
import { detectClaudeDesktop } from '../src/claude/desktop.ts';
import { claudeStatus, connectProfile, disconnectProfile, restoreBackup, type ServerCommand } from '../src/claude/integration.ts';
import { restartClaudeDesktop } from '../src/claude/restart.ts';
import { clientKind, readServeRecord, writeServeRecord } from '../src/state.ts';
import type { Profile } from '../src/profiles.ts';

// Everything happens under fake LOCALAPPDATA/APPDATA/USERPROFILE folders (tempHome),
// so the real Claude configs of this machine are never read or written.
let local: string;
let user: string;
let desktopConfig: string;
const server: ServerCommand = { command: 'C:\\Apps\\abap-adt-mcp\\abap-adt-mcp.exe', args: [] };
const qas: Profile = { id: 'QAS400', name: 'QAS 400', url: 'https://sap:44300', client: '400', username: 'U', environment: 'QAS' };
const prd: Profile = { ...qas, id: 'PRD100', name: 'PRD 100', client: '100', environment: 'PRD' };
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const noCli = () => ({ ...process.env, PATH: '', ABAP_ADT_MCP_CLAUDE_CLI: '' });

before(() => {
  tempHome();
  local = process.env.LOCALAPPDATA!;
  user = process.env.USERPROFILE!;
  // An MSIX install like the one on the development VM.
  fs.mkdirSync(path.join(local, 'Packages', 'Claude_test1234', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
  const dataDir = path.join(local, 'Claude-Data', 'claude_test1234');
  fs.mkdirSync(dataDir, { recursive: true });
  desktopConfig = path.join(dataDir, 'claude_desktop_config.json');
  fs.writeFileSync(desktopConfig, JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'x.exe', args: [] } } }));
  fs.writeFileSync(path.join(local, 'Packages', 'Claude_test1234', 'LocalCache', 'Roaming', 'Claude', '.user-data-left.claude_test1234'), '{}');
});

test('MSIX Claude Desktop: the config Claude really reads is found and relaunch uses the app id', () => {
  const d = detectClaudeDesktop()!;
  assert.equal(d.kind, 'msix');
  assert.equal(d.configPath, desktopConfig);
  assert.deepEqual(d.launch.args, ['shell:AppsFolder\\Claude_test1234!Claude']);
  assert.ok(d.exePattern.test('C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_arm64__test1234\\app\\Claude.exe'));
  assert.ok(!d.exePattern.test('C:\\Users\\u\\AppData\\Local\\Claude-Data\\x\\claude-code\\2.1\\h\\claude.exe'));
  assert.ok(!d.exePattern.test('C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_arm64__pzs8sxrjxfjjc\\app\\Claude.exe'), 'another package');
});

test('folders Claude moved away from (".user-data-left") are never used', () => {
  const env = { ...process.env, LOCALAPPDATA: path.join(local, '..', 'Local2') };
  const base = env.LOCALAPPDATA!;
  fs.mkdirSync(path.join(base, 'Packages', 'Claude_abc', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Packages', 'Claude_abc', 'LocalCache', 'Roaming', 'Claude', '.user-data-left.claude_abc'), '{}');
  assert.equal(detectClaudeDesktop(env)?.configPath, null);
  fs.rmSync(path.join(base, 'Packages', 'Claude_abc', 'LocalCache', 'Roaming', 'Claude', '.user-data-left.claude_abc'));
  assert.match(detectClaudeDesktop(env)!.configPath!, /LocalCache\\Roaming\\Claude\\claude_desktop_config\.json$/);
});

test('classic (Squirrel) install uses %APPDATA%\\Claude', () => {
  const root = fs.mkdtempSync(path.join(path.dirname(local), 'squirrel-'));
  const env = { ...process.env, LOCALAPPDATA: path.join(root, 'L'), APPDATA: path.join(root, 'R') };
  fs.mkdirSync(path.join(env.LOCALAPPDATA, 'AnthropicClaude'), { recursive: true });
  fs.writeFileSync(path.join(env.LOCALAPPDATA, 'AnthropicClaude', 'claude.exe'), '');
  const d = detectClaudeDesktop(env)!;
  assert.equal(d.kind, 'squirrel');
  assert.equal(d.configPath, path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'));
});

test('connecting to Claude Desktop adds only our entry, keeps everything else and makes a backup', async () => {
  const r = await connectProfile(qas, 'desktop', server);
  assert.deepEqual(r, { ok: true, restartSuggested: true });
  const cfg = readJson(desktopConfig);
  assert.deepEqual(cfg.preferences, { theme: 'dark' });
  assert.deepEqual(cfg.mcpServers.other, { command: 'x.exe', args: [] });
  assert.deepEqual(cfg.mcpServers['abap-adt-QAS400'], { command: server.command, args: ['serve', '--profile', 'QAS400'] });
  assert.ok(!JSON.stringify(cfg).includes('SAP_'));
  assert.equal(claudeStatus([qas], server).profiles.QAS400?.desktop.state, 'connected');
  assert.ok(fs.readdirSync(path.join(process.env.ABAP_ADT_MCP_HOME!, 'backups', 'claude-desktop')).length >= 1);
});

test('a different executable shows as outdated; a vanished entry as removed by another program', () => {
  assert.equal(claudeStatus([qas], { command: 'D:\\outro\\abap-adt-mcp.exe', args: [] }).profiles.QAS400?.desktop.state, 'outdated');
  const cfg = readJson(desktopConfig);
  delete cfg.mcpServers['abap-adt-QAS400'];
  fs.writeFileSync(desktopConfig, JSON.stringify(cfg));
  assert.equal(claudeStatus([qas], server).profiles.QAS400?.desktop.state, 'removed-externally');
});

test('production profiles need the typed confirmation', async () => {
  assert.deepEqual(await connectProfile(prd, 'desktop', server), { ok: false, error: 'prd-confirmation' });
  assert.deepEqual(await connectProfile(prd, 'desktop', server, { confirmation: 'prd100' }), { ok: false, error: 'prd-confirmation' });
  assert.equal((await connectProfile(prd, 'desktop', server, { confirmation: 'PRD100' })).ok, true);
});

test('removing takes our entry out and forgets the intent', async () => {
  await connectProfile(qas, 'desktop', server);
  assert.deepEqual(await disconnectProfile('QAS400', 'desktop'), { restartSuggested: true });
  assert.equal(readJson(desktopConfig).mcpServers['abap-adt-QAS400'], undefined);
  assert.equal(claudeStatus([qas], server).profiles.QAS400?.desktop.state, 'not-connected');
});

test('a corrupted Claude config is detected, never overwritten, and can be restored from backup', async () => {
  fs.writeFileSync(desktopConfig, '{ "mcpServers": { broken');
  const status = claudeStatus([qas], server);
  assert.equal(status.desktop.problem, 'config-corrupted');
  assert.ok(status.desktop.backupTime);
  assert.deepEqual(await connectProfile(qas, 'desktop', server), { ok: false, error: 'config-corrupted' });
  assert.equal(fs.readFileSync(desktopConfig, 'utf8'), '{ "mcpServers": { broken');
  assert.equal(restoreBackup('desktop'), true);
  assert.equal(readJson(desktopConfig).preferences.theme, 'dark');
  assert.ok(fs.readdirSync(path.join(process.env.ABAP_ADT_MCP_HOME!, 'backups', 'claude-desktop-replaced')).length === 1);
});

test('Claude Code with its official CLI: user scope, never a project file', async () => {
  const fakeCli = path.join(user, 'fake-claude.cjs');
  fs.writeFileSync(
    fakeCli,
    `const fs = require('fs'), path = require('path');
     const file = path.join(process.env.USERPROFILE, '.claude.json');
     let data = {}; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
     data.mcpServers = data.mcpServers || {};
     const a = process.argv.slice(2);
     fs.appendFileSync(file + '.calls', a.join(' ') + '\\n');
     if (a[0] === 'mcp' && a[1] === 'add') { const i = a.indexOf('--'); data.mcpServers[a[i - 1]] = { type: 'stdio', command: a[i + 1], args: a.slice(i + 2), env: {} }; }
     if (a[0] === 'mcp' && a[1] === 'remove') delete data.mcpServers[a[2]];
     fs.writeFileSync(file, JSON.stringify(data));`,
  );
  fs.writeFileSync(path.join(user, '.claude.json'), JSON.stringify({ projects: { 'C:/x': { allowedTools: [] } } }));
  const env = { ...process.env, ABAP_ADT_MCP_CLAUDE_CLI: JSON.stringify([process.execPath, fakeCli]) };
  const r = await connectProfile(qas, 'code', server, { env });
  assert.deepEqual(r, { ok: true, restartSuggested: false, via: 'cli' });
  const calls = fs.readFileSync(path.join(user, '.claude.json.calls'), 'utf8');
  assert.match(calls, /^mcp add --scope user abap-adt-QAS400 -- C:\\Apps\\abap-adt-mcp\\abap-adt-mcp\.exe serve --profile QAS400$/m);
  assert.equal(claudeStatus([qas], server, env).profiles.QAS400?.code.state, 'connected');
  await disconnectProfile('QAS400', 'code', env);
  assert.equal(readJson(path.join(user, '.claude.json')).mcpServers['abap-adt-QAS400'], undefined);
});

test('Claude Code without the CLI: ~/.claude.json is edited safely, other keys kept', async () => {
  const r = await connectProfile(qas, 'code', server, { env: noCli() });
  assert.equal(r.ok && r.via, 'file');
  const data = readJson(path.join(user, '.claude.json'));
  assert.deepEqual(data.projects, { 'C:/x': { allowedTools: [] } });
  assert.deepEqual(data.mcpServers['abap-adt-QAS400'], { type: 'stdio', command: server.command, args: ['serve', '--profile', 'QAS400'], env: {} });
});

test('restart closes only Claude Desktop (by path), waits, and opens it again', async () => {
  const install = detectClaudeDesktop()!;
  const app = 'C:\\Program Files\\WindowsApps\\Claude_1.0.0_x64__test1234\\app\\Claude.exe';
  let alive = true;
  const killed: number[] = [];
  const launched: string[][] = [];
  const deps = {
    list: () => [
      ...(alive ? [{ pid: 10, ppid: 1, path: app }, { pid: 11, ppid: 10, path: app }] : []),
      { pid: 20, ppid: 1, path: 'C:\\Users\\u\\.local\\bin\\claude.exe' },
    ],
    killTree: async (pid: number) => {
      killed.push(pid);
      alive = false;
    },
    launch: (command: string, args: string[]) => launched.push([command, ...args]),
    sleep: async () => undefined,
  };
  assert.deepEqual(await restartClaudeDesktop(install, deps), { ok: false, reason: 'disabled' });
  delete process.env.ABAP_ADT_MCP_DISABLE_CLAUDE_RESTART;
  try {
    assert.deepEqual(await restartClaudeDesktop(install, deps), { ok: true, wasRunning: true });
  } finally {
    process.env.ABAP_ADT_MCP_DISABLE_CLAUDE_RESTART = '1';
  }
  assert.deepEqual(killed, [10]);
  assert.deepEqual(launched, [[install.launch.command, 'shell:AppsFolder\\Claude_test1234!Claude']]);
});

test('usage proofs are kept per Claude client', () => {
  assert.equal(clientKind('claude-code'), 'code');
  assert.equal(clientKind('claude-ai'), 'desktop');
  assert.equal(clientKind('abap-adt-mcp-test'), 'other');
  writeServeRecord({ profileId: 'QAS400', startedAt: '2026-10-26T10:00:00.000Z', appVersion: 't', clientName: 'claude-ai', executable: 'x' });
  writeServeRecord({ profileId: 'QAS400', startedAt: '2026-10-26T11:00:00.000Z', appVersion: 't', clientName: 'claude-code', executable: 'x' });
  assert.equal(readServeRecord('QAS400', 'desktop')?.startedAt, '2026-10-26T10:00:00.000Z');
  assert.equal(claudeStatus([qas], server).profiles.QAS400?.code.lastUsed, '2026-10-26T11:00:00.000Z');
});
