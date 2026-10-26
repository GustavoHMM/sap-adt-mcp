import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isSea } from 'node:sea';

/**
 * Folder of the running exe, with junctions resolved once at start: Claude
 * launches runtime\current\abap-adt-mcp.exe, and an update may re-point
 * "current" while this process runs; every later file must come from our own
 * version.
 */
export const exeDir: string = (() => {
  try {
    return path.dirname(fs.realpathSync(process.execPath));
  } catch {
    return path.dirname(process.execPath);
  }
})();

/** The exe itself, through the resolved folder (used to start the upstream child). */
export const exePath: string = path.join(exeDir, path.basename(process.execPath));

/**
 * Loads native (N-API) modules. In the single-executable build they ship in a
 * node_modules folder next to the exe; in development they come from the repo.
 */
export const nativeRequire = createRequire(isSea() ? path.join(exeDir, 'index.js') : import.meta.url);

export type Koffi = typeof import('koffi').default;
export type Keyring = typeof import('@napi-rs/keyring');

let koffi: Koffi | undefined;
export function loadKoffi(): Koffi {
  koffi ??= nativeRequire('koffi') as Koffi;
  return koffi;
}

let keyring: Keyring | undefined;
export function loadKeyring(): Keyring {
  keyring ??= nativeRequire('@napi-rs/keyring') as Keyring;
  return keyring;
}
