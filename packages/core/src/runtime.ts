import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appHome } from './paths.ts';

/**
 * Claude configs point at runtime\current\abap-adt-mcp.exe, a junction to the
 * installed version's copy. Updates add runtime\<version>-<fingerprint> and re-point the
 * junction: configs never change, and a server Claude is still running keeps
 * its old files.
 */
export const runtimeRoot = (): string => path.join(appHome(), 'runtime');
export const currentDir = (): string => path.join(runtimeRoot(), 'current');
export const stableExe = (): string => path.join(currentDir(), 'abap-adt-mcp.exe');

function readJunction(dir: string): string | undefined {
  try {
    return path.resolve(fs.readlinkSync(dir));
  } catch {
    return undefined;
  }
}

export interface DeployResult {
  exe: string;
  version: string;
  /** True when the junction moved to this version. */
  switched: boolean;
  removedOld: string[];
}

/**
 * Identity of a CLI folder: every file's path and size. Two builds of one
 * version (e.g. a package fixed after a broken one) get different folders, so a
 * bad copy is never reused.
 */
export function folderFingerprint(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (name !== '.complete') lines.push(`${name}\t${fs.statSync(path.join(dir, name)).size}`);
    }
  };
  walk('');
  return crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex').slice(0, 8);
}

/** Copies the CLI shipped with the app into runtime\<version>-<fingerprint> (once) and points runtime\current at it. */
export function deployRuntime(sourceDir: string, version: string, inUse: (dir: string) => boolean = () => false): DeployResult {
  const root = runtimeRoot();
  const target = path.join(root, `${version}-${folderFingerprint(sourceDir)}`);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(target, '.complete'))) {
    const tmp = `${target}.partial-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(sourceDir, tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.complete'), version);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
  }

  const current = currentDir();
  let switched = false;
  if (readJunction(current) !== path.resolve(target)) {
    // Removing a junction never touches the folder it points to.
    if (fs.existsSync(current) || readJunction(current)) fs.rmdirSync(current);
    fs.symlinkSync(target, current, 'junction');
    switched = true;
  }

  const removedOld: string[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (name === 'current' || dir === target || inUse(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removedOld.push(name);
    } catch {
      // Still in use by a Claude session; next start tries again.
    }
  }
  return { exe: stableExe(), version, switched, removedOld };
}

/** Removes the whole runtime folder, skipping versions still in use. */
export function removeRuntime(inUse: (dir: string) => boolean = () => false): void {
  const root = runtimeRoot();
  if (!fs.existsSync(root)) return;
  const current = currentDir();
  if (readJunction(current)) fs.rmdirSync(current);
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (inUse(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // in use
    }
  }
  try {
    fs.rmdirSync(root);
  } catch {
    // not empty: a version is still running
  }
}

/** True when an executable path belongs to this app's runtime or to an installation folder of ours. */
export function isOurExecutable(command: string, installDirs: string[] = []): boolean {
  const c = path.resolve(command).toLowerCase();
  return [runtimeRoot(), ...installDirs].some((d) => c.startsWith(path.resolve(d).toLowerCase() + path.sep));
}
