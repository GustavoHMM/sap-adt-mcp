import fs from 'node:fs';

/** Injected by the single-executable build; read from package.json in development. */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string'
    ? __APP_VERSION__
    : (JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
