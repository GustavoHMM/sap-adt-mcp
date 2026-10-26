import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backupFile, readJsonFile, writeJsonAtomic, type JsonRead } from './json-file.ts';

export interface CodeInstall {
  /** The Claude Code CLI, when found (an .exe we can run without a shell). */
  cli: { command: string; args: string[] } | null;
  /** ~/.claude.json, where user-scope MCP servers live. */
  configPath: string;
  configExists: boolean;
}

function versionKey(name: string): number[] {
  return name.split(/[.\-]/).map((p) => Number(p) || 0);
}

function newestVersionDir(parent: string): string | undefined {
  try {
    const dirs = fs.readdirSync(parent).filter((n) => /^\d+\.\d+/.test(n));
    dirs.sort((a, b) => {
      const ka = versionKey(a);
      const kb = versionKey(b);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
      return 0;
    });
    return dirs[0] ? path.join(parent, dirs[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** claude.exe from PATH, the native installer, or the copy that ships with Claude Desktop. */
export function findClaudeCli(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  const override = env.ABAP_ADT_MCP_CLAUDE_CLI;
  if (override === 'none') return null;
  if (override) {
    const parsed = JSON.parse(override) as string[];
    return { command: parsed[0]!, args: parsed.slice(1) };
  }
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) candidates.push(path.join(dir, 'claude.exe'));
  if (env.USERPROFILE) candidates.push(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  const dataRoot = path.join(env.LOCALAPPDATA ?? '', 'Claude-Data');
  try {
    for (const install of fs.readdirSync(dataRoot)) {
      const version = newestVersionDir(path.join(dataRoot, install, 'claude-code'));
      if (!version) continue;
      for (const build of fs.readdirSync(version)) candidates.push(path.join(version, build, 'claude.exe'));
    }
  } catch {
    // no Claude Desktop data
  }
  const found = candidates.find((c) => fs.existsSync(c));
  return found ? { command: found, args: [] } : null;
}

/** Claude Code keeps .claude.json in CLAUDE_CONFIG_DIR when set, else in the user's home folder. */
export function claudeCodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || env.USERPROFILE || '', '.claude.json');
}

export function detectClaudeCode(env: NodeJS.ProcessEnv = process.env): CodeInstall | null {
  const configPath = claudeCodeConfigPath(env);
  const cli = findClaudeCli(env);
  const configExists = fs.existsSync(configPath);
  if (!cli && !configExists) return null;
  return { cli, configPath, configExists };
}

export function readCodeServers(install: CodeInstall): { read: JsonRead; servers: Record<string, unknown> } {
  const read = readJsonFile(install.configPath);
  const servers = read.kind === 'ok' && read.data.mcpServers && typeof read.data.mcpServers === 'object' ? (read.data.mcpServers as Record<string, unknown>) : {};
  return { read, servers };
}

function runCli(install: CodeInstall, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(install.cli!.command, [...install.cli!.args, ...args], { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` });
    });
  });
}

/**
 * Registers a user-scope server: with the official CLI when available (it
 * knows its own file), otherwise by editing ~/.claude.json safely. Never a
 * project .mcp.json.
 */
export async function addCodeServer(install: CodeInstall, name: string, command: string, args: string[]): Promise<'cli' | 'file'> {
  if (install.cli) {
    if (name in readCodeServers(install).servers) await runCli(install, ['mcp', 'remove', name, '--scope', 'user']);
    const r = await runCli(install, ['mcp', 'add', '--scope', 'user', name, '--', command, ...args]);
    if (r.code === 0 && matches(readCodeServers(install).servers[name], command, args)) return 'cli';
  }
  editCodeFile(install, (servers) => {
    servers[name] = { type: 'stdio', command, args, env: {} };
  });
  return 'file';
}

export async function removeCodeServer(install: CodeInstall, name: string): Promise<void> {
  if (!(name in readCodeServers(install).servers)) return;
  if (install.cli) {
    await runCli(install, ['mcp', 'remove', name, '--scope', 'user']);
    if (!(name in readCodeServers(install).servers)) return;
  }
  editCodeFile(install, (servers) => {
    delete servers[name];
  });
}

function editCodeFile(install: CodeInstall, change: (servers: Record<string, unknown>) => void): void {
  const read = readJsonFile(install.configPath);
  if (read.kind === 'corrupted') throw new Error(`~/.claude.json is not valid JSON (${read.error})`);
  const data = read.kind === 'ok' ? read.data : {};
  const servers = (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}) as Record<string, unknown>;
  change(servers);
  data.mcpServers = servers;
  backupFile(install.configPath, 'claude-code');
  writeJsonAtomic(install.configPath, data);
}

/** Same executable (paths compared without regard to case) and same arguments. */
export function matches(entry: unknown, command: string, args: string[]): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { command?: unknown; args?: unknown };
  return (
    typeof e.command === 'string' &&
    path.normalize(e.command).toLowerCase() === path.normalize(command).toLowerCase() &&
    Array.isArray(e.args) &&
    e.args.length === args.length &&
    e.args.every((a, i) => a === args[i])
  );
}
