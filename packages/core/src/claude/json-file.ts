import fs from 'node:fs';
import path from 'node:path';
import { appHome } from '../paths.ts';

export type JsonRead =
  | { kind: 'missing' }
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'corrupted'; error: string };

/** Reads a JSON config written by another program (BOM tolerated, never throws on bad content). */
export function readJsonFile(file: string): JsonRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupted', error: (e as Error).message };
  }
  text = text.replace(/^﻿/, '');
  if (!text.trim()) return { kind: 'ok', data: {} };
  try {
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'corrupted', error: 'not a JSON object' };
    return { kind: 'ok', data: data as Record<string, unknown> };
  } catch (e) {
    return { kind: 'corrupted', error: (e as Error).message };
  }
}

const backupDir = (client: string) => path.join(appHome(), 'backups', client);
const KEEP = 10;

/** Copies the current file before we touch it; keeps the latest ten copies per client. */
export function backupFile(file: string, client: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const dir = backupDir(client);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.copyFileSync(file, target);
  const all = listBackups(client);
  for (const old of all.slice(KEEP)) fs.rmSync(old.file, { force: true });
  return target;
}

export function listBackups(client: string): { file: string; time: Date }[] {
  const dir = backupDir(client);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n) => ({ file: path.join(dir, n), time: fs.statSync(path.join(dir, n)).mtime }))
    .sort((a, b) => b.time.getTime() - a.time.getTime());
}

/** Newest backup that is still valid JSON. */
export function latestValidBackup(client: string): { file: string; time: Date } | undefined {
  return listBackups(client).find((b) => readJsonFile(b.file).kind === 'ok');
}

/** Writes next to the target and renames, so readers never see half a file; then reads it back. */
export function writeJsonAtomic(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.abap-adt-mcp-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  if (readJsonFile(file).kind !== 'ok') throw new Error(`could not verify ${file} after writing`);
}
