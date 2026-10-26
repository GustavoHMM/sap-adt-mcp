import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppInfo, TestEvent, TestStep } from '../shared/api.ts';

export interface CliLocation {
  command: string;
  args: string[];
}

/**
 * The connection test runs in abap-adt-mcp.exe, the same runtime Claude uses,
 * so "test passed" means "works in Claude". ABAP_ADT_MCP_CLI_SOURCE (a node.exe
 * path) runs the CLI from source instead; used by tests and development.
 */
export function locateCli(options: { packaged: boolean; resourcesPath: string; repoRoot: string }): CliLocation {
  const fromSource = process.env.ABAP_ADT_MCP_CLI_SOURCE;
  if (fromSource) return { command: fromSource, args: [path.join(options.repoRoot, 'apps', 'cli', 'src', 'main.ts')] };
  if (options.packaged) return { command: path.join(options.resourcesPath, 'cli', 'abap-adt-mcp.exe'), args: [] };
  const built = path.join(options.repoRoot, 'build', 'cli', `win-${process.arch}`, 'abap-adt-mcp.exe');
  if (fs.existsSync(built)) return { command: built, args: [] };
  return { command: 'node', args: [path.join(options.repoRoot, 'apps', 'cli', 'src', 'main.ts')] };
}

export interface RunningTest {
  runId: string;
  cancel(): void;
}

let counter = 0;

/** Starts "test --json" and turns each NDJSON line into a step event. */
export function runCliTest(cli: CliLocation, profileId: string, env: NodeJS.ProcessEnv, emit: (event: TestEvent) => void): RunningTest {
  const runId = `run-${Date.now()}-${++counter}`;
  let child: ChildProcess;
  try {
    child = spawn(cli.command, [...cli.args, 'test', '--profile', profileId, '--json'], { env, windowsHide: true });
  } catch (e) {
    queueMicrotask(() => emit({ runId, kind: 'error', message: (e as Error).message }));
    return { runId, cancel: () => undefined };
  }
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        emit({ runId, kind: 'step', step: JSON.parse(line) as TestStep });
      } catch {
        // Not a step line; ignore.
      }
    }
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => (stderr += chunk).length);
  child.once('error', (e) => emit({ runId, kind: 'error', message: e.message }));
  child.once('exit', (code) => {
    if (code !== 0 && code !== 2 && stderr.trim()) emit({ runId, kind: 'error', message: stderr.trim().split('\n')[0]!.slice(0, 300) });
    emit({ runId, kind: 'done', exitCode: code });
  });
  return { runId, cancel: () => child.kill() };
}

/** Runs "diagnostics --out <file>" (DNS/TCP/TLS without password included) and waits for it. */
export function runCliDiagnostics(cli: CliLocation, env: NodeJS.ProcessEnv, file: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(cli.command, [...cli.args, 'diagnostics', '--out', file], { env, windowsHide: true });
    child.stdout.resume();
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.once('error', (e) => resolve({ ok: false, error: e.message }));
    child.once('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().split('\n')[0]?.slice(0, 300) || `exit ${code}` }));
  });
}

export function cliVersion(cli: CliLocation, env: NodeJS.ProcessEnv): Promise<AppInfo['cli']> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cli.command, [...cli.args, 'version', '--json'], { env, windowsHide: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.once('error', () => resolve(null));
    child.once('exit', () => {
      try {
        resolve(JSON.parse(out) as AppInfo['cli']);
      } catch {
        resolve(null);
      }
    });
  });
}
