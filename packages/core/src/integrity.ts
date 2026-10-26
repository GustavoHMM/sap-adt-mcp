import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** SHA-256 of upstream/MANIFEST.json, baked into the (signed) executable at build time. */
declare const __UPSTREAM_MANIFEST_SHA256__: string | undefined;

export const MANIFEST_FILE = 'MANIFEST.json';

export interface Manifest {
  algorithm: 'sha256';
  files: Record<string, string>;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Lists every file under dir (forward slashes) with its SHA-256. */
export function buildManifest(dir: string): Manifest {
  const files: Record<string, string> = {};
  const walk = (sub: string) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (rel !== MANIFEST_FILE) files[rel] = sha256(fs.readFileSync(path.join(dir, rel)));
    }
  };
  walk('');
  return { algorithm: 'sha256', files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
}

export type IntegrityResult = { ok: true; checked: number } | { ok: false; problem: string };

/**
 * Before serving, checks that the upstream files are exactly the ones built
 * with this executable. A planted or edited file (the install folder is
 * writable by the user) blocks the server instead of running altered code.
 */
export function verifyUpstream(dir: string, expectedManifestHash = typeof __UPSTREAM_MANIFEST_SHA256__ === 'string' ? __UPSTREAM_MANIFEST_SHA256__ : undefined): IntegrityResult {
  if (!expectedManifestHash) return { ok: true, checked: 0 };
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path.join(dir, MANIFEST_FILE));
  } catch {
    return { ok: false, problem: 'manifest missing' };
  }
  if (sha256(raw) !== expectedManifestHash) return { ok: false, problem: 'manifest changed' };
  const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
  let checked = 0;
  for (const [rel, hash] of Object.entries(manifest.files)) {
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(dir, ...rel.split('/')));
    } catch {
      return { ok: false, problem: `missing ${rel}` };
    }
    if (sha256(data) !== hash) return { ok: false, problem: `changed ${rel}` };
    checked++;
  }
  return { ok: true, checked };
}

export function manifestHash(dir: string): string {
  return sha256(fs.readFileSync(path.join(dir, MANIFEST_FILE)));
}
