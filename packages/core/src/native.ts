import { createRequire } from 'node:module';
import path from 'node:path';
import { isSea } from 'node:sea';

/**
 * Loads native (N-API) modules. In the single-executable build they ship in a
 * node_modules folder next to the exe; in development they come from the repo.
 */
export const nativeRequire = createRequire(
  isSea() ? path.join(path.dirname(process.execPath), 'index.js') : import.meta.url,
);

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
