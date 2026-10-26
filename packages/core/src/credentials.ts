import { loadKeyring } from './native.ts';

/**
 * Credential Manager is shared by the whole Windows account, unlike the data
 * folder, so tests set ABAP_ADT_MCP_CREDENTIAL_NAMESPACE to never touch real
 * passwords (a test profile named QAS400 must not overwrite the real one).
 */
function service(): string {
  const ns = process.env.ABAP_ADT_MCP_CREDENTIAL_NAMESPACE;
  return ns && /^[a-z0-9-]+$/i.test(ns) ? `abap-adt-mcp-${ns}` : 'abap-adt-mcp';
}

/**
 * Name shown in Windows Credential Manager (generic credentials). It comes from the
 * library's default "<account>.<service>" scheme: Entry.withTarget() was ruled out
 * because on Windows a new Entry built with it reads the saved password as empty
 * (checked with @napi-rs/keyring 1.3.0 to 2.1.2).
 */
export function credentialTarget(profileId: string): string {
  return `${profileId}.${service()}`;
}

function entry(profileId: string) {
  const { Entry } = loadKeyring();
  return new Entry(service(), profileId);
}

export function setPassword(profileId: string, password: string): void {
  entry(profileId).setPassword(password);
}

/** Null when nothing is saved. */
export function getPassword(profileId: string): string | null {
  return entry(profileId).getPassword() || null;
}

export function deletePassword(profileId: string): boolean {
  return entry(profileId).deletePassword();
}
