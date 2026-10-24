import os from 'node:os';
import path from 'node:path';

export const APP_ID = 'abap-adt-mcp';

/** Folder for profiles, certificates, logs and state. ABAP_ADT_MCP_HOME overrides it (tests). */
export function appHome(): string {
  const override = process.env.ABAP_ADT_MCP_HOME;
  if (override) return override;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, APP_ID);
}

export const profilesFile = (): string => path.join(appHome(), 'profiles.json');
export const logsDir = (): string => path.join(appHome(), 'logs');
export const stateDir = (): string => path.join(appHome(), 'state');
export const certsDir = (): string => path.join(appHome(), 'certs');
