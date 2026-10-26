import { execFile, spawn } from 'node:child_process';
import type { DesktopInstall } from './desktop.ts';
import { listProcesses, type ProcessInfo } from './processes.ts';

export interface RestartDeps {
  list: () => ProcessInfo[];
  killTree: (pid: number) => Promise<void>;
  launch: (command: string, args: string[]) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: RestartDeps = {
  list: listProcesses,
  killTree: (pid) =>
    new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())),
  launch: (command, args) => spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Claude Desktop's own processes, matched by executable path (Claude Code is also "claude.exe"). */
export function desktopProcesses(install: DesktopInstall, list: () => ProcessInfo[] = listProcesses): ProcessInfo[] {
  return list().filter((p) => p.path !== null && install.exePattern.test(p.path));
}

export type RestartResult = { ok: true; wasRunning: boolean } | { ok: false; reason: 'disabled' | 'still-running' };

/**
 * Closes Claude Desktop (only its own process tree, found by path, never by
 * name) and opens it again so it reads the new MCP configuration. Callers must
 * ask first: open conversations and Code sessions are interrupted.
 */
export async function restartClaudeDesktop(install: DesktopInstall, deps: Partial<RestartDeps> = {}): Promise<RestartResult> {
  if (process.env.ABAP_ADT_MCP_DISABLE_CLAUDE_RESTART === '1') return { ok: false, reason: 'disabled' };
  const d = { ...defaultDeps, ...deps };
  const running = desktopProcesses(install, d.list);
  const roots = running.filter((p) => !running.some((q) => q.pid === p.ppid));
  for (const root of roots) await d.killTree(root.pid);
  for (let i = 0; running.length && i < 40; i++) {
    if (!desktopProcesses(install, d.list).length) break;
    await d.sleep(250);
  }
  if (desktopProcesses(install, d.list).length) return { ok: false, reason: 'still-running' };
  d.launch(install.launch.command, install.launch.args);
  return { ok: true, wasRunning: running.length > 0 };
}
