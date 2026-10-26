import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.ts';

/**
 * Proof that a Claude client really started this profile's server: the app
 * shows "connected and in use" only when this record exists.
 */
export interface ServeRecord {
  profileId: string;
  startedAt: string;
  appVersion: string;
  clientName?: string;
  clientVersion?: string;
  executable: string;
}

export type ClientKind = 'desktop' | 'code';

/** MCP clientInfo name → which Claude it is ("claude-code" vs Claude Desktop's "claude-ai"). */
export function clientKind(clientName: string | undefined): ClientKind | 'other' {
  const name = (clientName ?? '').toLowerCase();
  if (name.includes('claude-code')) return 'code';
  if (name.startsWith('claude')) return 'desktop';
  return 'other';
}

const recordFile = (profileId: string, kind?: string) => path.join(stateDir(), kind ? `serve-${profileId}.${kind}.json` : `serve-${profileId}.json`);

export function writeServeRecord(record: ServeRecord): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const text = JSON.stringify(record, null, 2) + '\n';
    fs.writeFileSync(recordFile(record.profileId), text, 'utf8');
    fs.writeFileSync(recordFile(record.profileId, clientKind(record.clientName)), text, 'utf8');
  } catch {
    // Best effort; serving must go on.
  }
}

/** Latest start by any client, or by one kind of Claude. */
export function readServeRecord(profileId: string, kind?: ClientKind): ServeRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordFile(profileId, kind), 'utf8')) as ServeRecord;
  } catch {
    return undefined;
  }
}

export function removeServeRecords(profileId: string): void {
  for (const kind of [undefined, 'desktop', 'code', 'other']) fs.rmSync(recordFile(profileId, kind), { force: true });
}
