import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.ts';

/**
 * Proof that a Claude client really started this profile's server: the app
 * shows "connected and in use" only when this record exists and is recent.
 */
export interface ServeRecord {
  profileId: string;
  startedAt: string;
  appVersion: string;
  clientName?: string;
  clientVersion?: string;
  executable: string;
}

const recordFile = (profileId: string) => path.join(stateDir(), `serve-${profileId}.json`);

export function writeServeRecord(record: ServeRecord): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(recordFile(record.profileId), JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch {
    // Best effort; serving must go on.
  }
}

export function readServeRecord(profileId: string): ServeRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordFile(profileId), 'utf8')) as ServeRecord;
  } catch {
    return undefined;
  }
}
