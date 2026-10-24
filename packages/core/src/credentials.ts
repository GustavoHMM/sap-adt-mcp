import { loadKeyring } from './native.ts';

const SERVICE = 'abap-adt-mcp';

/**
 * Name shown in Windows Credential Manager (generic credentials). It comes from the
 * library's default "<account>.<service>" scheme: Entry.withTarget() was ruled out
 * because on Windows a new Entry built with it reads the saved password as empty
 * (checked with @napi-rs/keyring 1.3.0 to 2.1.2).
 */
export function credentialTarget(profileId: string): string {
  return `${profileId}.${SERVICE}`;
}

function entry(profileId: string) {
  const { Entry } = loadKeyring();
  return new Entry(SERVICE, profileId);
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
