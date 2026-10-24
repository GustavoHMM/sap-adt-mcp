import path from 'node:path';

/**
 * Variables copied from our own environment into the upstream process. Anything
 * else (NODE_OPTIONS, *_PROXY, SSLKEYLOGFILE, TLS overrides, SAP_* left in the
 * user's environment) is dropped on purpose.
 */
const PASSTHROUGH = new Set(
  [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'USERNAME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'APPDATA',
    'ProgramData',
    'ComSpec',
    'PATHEXT',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
  ].map((k) => k.toLowerCase()),
);

export interface SapConnection {
  url: string;
  username: string;
  password: string;
  client: string;
  language?: string;
}

export interface ChildEnvOptions {
  sap: SapConnection;
  /** PEM file trusted only for this profile, in addition to the Windows store. */
  extraCaFile?: string;
  proxyUrl?: string | null;
}

export function buildChildEnv(base: NodeJS.ProcessEnv, options: ChildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && PASSTHROUGH.has(key.toLowerCase())) env[key] = value;
  }
  // Only system folders on PATH, so DLLs are never picked up from user-writable folders.
  const systemRoot = env.SystemRoot ?? base.SystemRoot ?? 'C:\\Windows';
  env.PATH = [path.join(systemRoot, 'System32'), systemRoot].join(';');

  const { sap } = options;
  env.SAP_URL = sap.url;
  env.SAP_USERNAME = sap.username;
  env.SAP_PASSWORD = sap.password;
  env.SAP_CLIENT = sap.client;
  env.SAP_LANGUAGE = sap.language ?? '';
  // Defined explicitly so a stray .env can never supply them (dotenv keeps existing values).
  env.SAP_CA_FILE = '';
  env.TLS_REJECT_UNAUTHORIZED = '1';
  env.NODE_USE_SYSTEM_CA = '1';
  if (options.extraCaFile) env.NODE_EXTRA_CA_CERTS = options.extraCaFile;
  if (options.proxyUrl) {
    // axios tunnels HTTPS through the proxy with CONNECT, so TLS stays end to end.
    env.HTTPS_PROXY = options.proxyUrl;
    env.HTTP_PROXY = options.proxyUrl;
    env.NO_PROXY = '';
  }
  return env;
}
