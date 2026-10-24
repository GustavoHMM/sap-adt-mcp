import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

/** Internal subcommand that turns the single executable into the upstream server process. */
export const UPSTREAM_SUBCOMMAND = '__upstream';

/**
 * Folder holding the unmodified mcp-abap-adt build: next to the exe in the
 * packaged app, or the git submodule in development.
 */
export function upstreamDir(): string {
  if (isSea()) return path.join(path.dirname(process.execPath), 'upstream');
  return fileURLToPath(new URL('../../../vendor/mcp-abap-adt/', import.meta.url));
}

export function upstreamEntry(): string {
  return path.join(upstreamDir(), 'dist', 'index.js');
}

/** How to start the upstream as a child process with the current runtime. */
export function upstreamCommand(): { command: string; args: string[] } {
  if (isSea()) return { command: process.execPath, args: [UPSTREAM_SUBCOMMAND] };
  return { command: process.execPath, args: [upstreamEntry()] };
}

export interface UpstreamInfo {
  name: string;
  version: string;
  commit?: string;
}

/** Version shown to people; the commit matters because npm 1.2.0 differs from git 1.2.0. */
export function upstreamInfo(): UpstreamInfo {
  const dir = upstreamDir();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string; version: string };
  let commit: string | undefined;
  try {
    commit = (JSON.parse(fs.readFileSync(path.join(dir, 'UPSTREAM-INFO.json'), 'utf8')) as { commit?: string }).commit;
  } catch {
    commit = readGitHead(dir);
  }
  return { name: pkg.name, version: pkg.version, commit };
}

function readGitHead(dir: string): string | undefined {
  try {
    let gitDir = path.join(dir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, 'utf8').trim().replace(/^gitdir:\s*/, '');
      gitDir = path.resolve(dir, pointer);
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The upstream loads "<package>/.env" with dotenv. A planted file could add
 * TLS_REJECT_UNAUTHORIZED=0, so serving refuses to start when one exists.
 */
export function hasStrayDotEnv(): boolean {
  return fs.existsSync(path.join(upstreamDir(), '.env'));
}

/** Runs the upstream server inside this process (single-executable child mode). */
export async function runUpstreamInProcess(): Promise<void> {
  const { createRequire } = await import('node:module');
  const load = createRequire(upstreamEntry());
  const upstream = load(upstreamEntry()) as { mcp_abap_adt_server: new () => { run(): Promise<void> } };
  await new upstream.mcp_abap_adt_server().run();
}
