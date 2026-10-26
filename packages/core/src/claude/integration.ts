import fs from 'node:fs';
import { mcpServerName, type Profile } from '../profiles.ts';
import { loadSettings, saveSettings } from '../settings.ts';
import { readServeRecord, type ClientKind } from '../state.ts';
import { addCodeServer, detectClaudeCode, matches, readCodeServers, removeCodeServer } from './code.ts';
import { detectClaudeDesktop, type DesktopInstall } from './desktop.ts';
import { backupFile, latestValidBackup, readJsonFile, writeJsonAtomic } from './json-file.ts';
import { desktopProcesses } from './restart.ts';

export type { ClientKind };

/** How Claude must start the server; configs get only this and the profile id, never SAP_* values. */
export interface ServerCommand {
  command: string;
  args: string[];
}

export const serveArgs = (server: ServerCommand, profileId: string) => [...server.args, 'serve', '--profile', profileId];

export type EntryState = 'connected' | 'not-connected' | 'outdated' | 'removed-externally';

export interface ProfileClaudeState {
  state: EntryState;
  /** When this Claude last started the profile's server (proof of real use). */
  lastUsed?: string;
}

export interface ClientState {
  installed: boolean;
  configPath: string | null;
  problem?: 'config-corrupted' | 'config-unknown';
  /** Time of the newest valid backup we can restore. */
  backupTime?: string;
  running?: boolean;
  cliAvailable?: boolean;
}

export interface ClaudeStatus {
  desktop: ClientState;
  code: ClientState;
  profiles: Record<string, Record<ClientKind, ProfileClaudeState>>;
}

const BACKUP = { desktop: 'claude-desktop', code: 'claude-code' } as const;

function desktopServers(install: DesktopInstall | null): { servers: Record<string, unknown>; problem?: ClientState['problem'] } {
  if (!install) return { servers: {} };
  if (!install.configPath) return { servers: {}, problem: 'config-unknown' };
  const read = readJsonFile(install.configPath);
  if (read.kind === 'corrupted') return { servers: {}, problem: 'config-corrupted' };
  const servers = read.kind === 'ok' && read.data.mcpServers && typeof read.data.mcpServers === 'object' ? (read.data.mcpServers as Record<string, unknown>) : {};
  return { servers };
}

function setIntent(profileId: string, kind: ClientKind, wanted: boolean): void {
  const settings = loadSettings();
  const claude = settings.claude ?? {};
  claude[profileId] = { ...claude[profileId], [kind]: wanted || undefined };
  if (!claude[profileId]?.desktop && !claude[profileId]?.code) delete claude[profileId];
  settings.claude = claude;
  saveSettings(settings);
}

export function forgetProfile(profileId: string): void {
  const settings = loadSettings();
  if (settings.claude?.[profileId]) {
    delete settings.claude[profileId];
    saveSettings(settings);
  }
}

export function claudeStatus(profiles: Profile[], server: ServerCommand, env: NodeJS.ProcessEnv = process.env): ClaudeStatus {
  const desktop = detectClaudeDesktop(env);
  const code = detectClaudeCode(env);
  const d = desktopServers(desktop);
  const c = code ? readCodeServers(code) : undefined;
  const intents = loadSettings().claude ?? {};
  const backup = (kind: ClientKind) => latestValidBackup(BACKUP[kind])?.time.toISOString();
  let running = false;
  try {
    running = desktop ? desktopProcesses(desktop).length > 0 : false;
  } catch {
    running = false;
  }

  const result: ClaudeStatus = {
    desktop: { installed: Boolean(desktop), configPath: desktop?.configPath ?? null, problem: d.problem, backupTime: d.problem ? backup('desktop') : undefined, running },
    code: {
      installed: Boolean(code),
      configPath: code?.configPath ?? null,
      problem: c?.read.kind === 'corrupted' ? 'config-corrupted' : undefined,
      backupTime: c?.read.kind === 'corrupted' ? backup('code') : undefined,
      cliAvailable: Boolean(code?.cli),
    },
    profiles: {},
  };
  for (const p of profiles) {
    const name = mcpServerName(p.id);
    const args = serveArgs(server, p.id);
    const stateFor = (kind: ClientKind, servers: Record<string, unknown>): ProfileClaudeState => {
      const entry = servers[name];
      const state: EntryState = entry
        ? matches(entry, server.command, args)
          ? 'connected'
          : 'outdated'
        : intents[p.id]?.[kind]
          ? 'removed-externally'
          : 'not-connected';
      return { state, lastUsed: readServeRecord(p.id, kind)?.startedAt };
    };
    result.profiles[p.id] = { desktop: stateFor('desktop', d.servers), code: stateFor('code', c?.servers ?? {}) };
  }
  return result;
}

export type ConnectResult =
  | { ok: true; restartSuggested: boolean; via?: 'cli' | 'file' }
  | { ok: false; error: 'not-installed' | 'config-unknown' | 'config-corrupted' | 'prd-confirmation' };

/**
 * Adds the profile to one Claude. Production profiles need the person to type
 * the profile id; this is checked here, not only in the window.
 */
export async function connectProfile(
  profile: Profile,
  kind: ClientKind,
  server: ServerCommand,
  options: { confirmation?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ConnectResult> {
  if (profile.environment === 'PRD' && options.confirmation !== profile.id) return { ok: false, error: 'prd-confirmation' };
  const env = options.env ?? process.env;
  const name = mcpServerName(profile.id);
  const args = serveArgs(server, profile.id);

  if (kind === 'code') {
    const code = detectClaudeCode(env);
    if (!code) return { ok: false, error: 'not-installed' };
    if (readCodeServers(code).read.kind === 'corrupted') return { ok: false, error: 'config-corrupted' };
    const via = await addCodeServer(code, name, server.command, args);
    setIntent(profile.id, 'code', true);
    return { ok: true, restartSuggested: false, via };
  }

  const desktop = detectClaudeDesktop(env);
  if (!desktop) return { ok: false, error: 'not-installed' };
  if (!desktop.configPath) return { ok: false, error: 'config-unknown' };
  const read = readJsonFile(desktop.configPath);
  if (read.kind === 'corrupted') return { ok: false, error: 'config-corrupted' };
  const data = read.kind === 'ok' ? read.data : {};
  const servers = (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}) as Record<string, unknown>;
  servers[name] = { command: server.command, args };
  data.mcpServers = servers;
  backupFile(desktop.configPath, BACKUP.desktop);
  writeJsonAtomic(desktop.configPath, data);
  setIntent(profile.id, 'desktop', true);
  return { ok: true, restartSuggested: true };
}

export async function disconnectProfile(profileId: string, kind: ClientKind, env: NodeJS.ProcessEnv = process.env): Promise<{ restartSuggested: boolean }> {
  const name = mcpServerName(profileId);
  setIntent(profileId, kind, false);
  if (kind === 'code') {
    const code = detectClaudeCode(env);
    if (code && readCodeServers(code).read.kind !== 'corrupted') await removeCodeServer(code, name);
    return { restartSuggested: false };
  }
  const desktop = detectClaudeDesktop(env);
  if (!desktop?.configPath) return { restartSuggested: false };
  const read = readJsonFile(desktop.configPath);
  if (read.kind !== 'ok') return { restartSuggested: false };
  const servers = read.data.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(name in servers)) return { restartSuggested: false };
  delete servers[name];
  backupFile(desktop.configPath, BACKUP.desktop);
  writeJsonAtomic(desktop.configPath, read.data);
  return { restartSuggested: true };
}

/** Puts back the newest valid backup over a corrupted (or wiped) Claude config; the bad file is kept as a backup too. */
export function restoreBackup(kind: ClientKind, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = kind === 'desktop' ? detectClaudeDesktop(env)?.configPath : detectClaudeCode(env)?.configPath;
  const backup = latestValidBackup(BACKUP[kind]);
  if (!target || !backup) return false;
  backupFile(target, `${BACKUP[kind]}-replaced`);
  fs.copyFileSync(backup.file, target);
  return readJsonFile(target).kind === 'ok';
}
