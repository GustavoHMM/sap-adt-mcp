import fs from 'node:fs';
import path from 'node:path';
import { profilesFile } from './paths.ts';
import { normalizeSapUrl, UrlError } from './url.ts';

export type Environment = 'DEV' | 'QAS' | 'PRD';
export const ENVIRONMENTS: readonly Environment[] = ['DEV', 'QAS', 'PRD'];

export type ProxySetting =
  | { mode: 'system' }
  | { mode: 'direct' }
  | { mode: 'manual'; url: string }
  | { mode: 'pac'; url: string };

/** A server certificate the person chose to trust for this profile only. */
export interface TrustedCertificate {
  file: string;
  fingerprint256: string;
  subject: string;
  validTo: string;
}

export interface Profile {
  id: string;
  name: string;
  url: string;
  client: string;
  username: string;
  language?: string;
  environment: Environment;
  /** Tools hidden from Claude. When absent, the environment default applies. */
  disabledTools?: string[];
  proxy?: ProxySetting;
  trustedCertificate?: TrustedCertificate;
  /** Explicit acceptance of plain HTTP. Never valid for PRD. */
  allowInsecureHttp?: boolean;
}

interface ProfilesDocument {
  version: 1;
  profiles: Profile[];
}

export const PROFILE_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type ProfileProblem =
  | 'id'
  | 'name'
  | 'url'
  | 'client'
  | 'username'
  | 'language'
  | 'environment'
  | 'http-in-prd'
  | 'http-not-accepted'
  | 'proxy';

export function validateProfile(p: Profile): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  if (!PROFILE_ID.test(p.id)) problems.push('id');
  if (!p.name?.trim()) problems.push('name');
  let origin: string | undefined;
  try {
    origin = normalizeSapUrl(p.url).origin;
    if (origin !== p.url) problems.push('url');
  } catch (e) {
    if (!(e instanceof UrlError)) throw e;
    problems.push('url');
  }
  if (!/^\d{3}$/.test(p.client)) problems.push('client');
  if (!p.username || p.username.length > 40 || p.username.includes(':')) problems.push('username');
  if (p.language !== undefined && !/^[A-Za-z]{2}$/.test(p.language)) problems.push('language');
  if (!ENVIRONMENTS.includes(p.environment)) problems.push('environment');
  if (origin?.startsWith('http:')) {
    if (p.environment === 'PRD') problems.push('http-in-prd');
    else if (!p.allowInsecureHttp) problems.push('http-not-accepted');
  }
  if (p.proxy && (p.proxy.mode === 'manual' || p.proxy.mode === 'pac')) {
    try {
      const u = new URL(p.proxy.url);
      if (!['http:', 'https:'].includes(u.protocol)) problems.push('proxy');
    } catch {
      problems.push('proxy');
    }
  }
  return problems;
}

/** GetTableContents reads business data, so it starts disabled outside DEV. */
export function defaultDisabledTools(env: Environment): string[] {
  return env === 'DEV' ? [] : ['GetTableContents'];
}

export function effectiveDisabledTools(p: Profile): Set<string> {
  return new Set(p.disabledTools ?? defaultDisabledTools(p.environment));
}

export function mcpServerName(profileId: string): string {
  return `abap-adt-${profileId}`;
}

function readDocument(): ProfilesDocument {
  let text: string;
  try {
    text = fs.readFileSync(profilesFile(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: [] };
    throw e;
  }
  const doc = JSON.parse(text) as ProfilesDocument;
  if (doc.version !== 1 || !Array.isArray(doc.profiles)) throw new Error('profiles.json has an unsupported format');
  return doc;
}

function writeDocument(doc: ProfilesDocument): void {
  const file = profilesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

export function loadProfiles(): Profile[] {
  return readDocument().profiles;
}

/** Profile ids are matched without regard to case, as people type them. */
export function getProfile(id: string): Profile | undefined {
  const wanted = id.toLowerCase();
  return loadProfiles().find((p) => p.id.toLowerCase() === wanted);
}

export function saveProfile(profile: Profile): void {
  const problems = validateProfile(profile);
  if (problems.length) throw new ProfileValidationError(problems);
  const doc = readDocument();
  const index = doc.profiles.findIndex((p) => p.id.toLowerCase() === profile.id.toLowerCase());
  if (index >= 0) doc.profiles[index] = profile;
  else doc.profiles.push(profile);
  writeDocument(doc);
}

export function removeProfile(id: string): boolean {
  const doc = readDocument();
  const before = doc.profiles.length;
  doc.profiles = doc.profiles.filter((p) => p.id.toLowerCase() !== id.toLowerCase());
  if (doc.profiles.length === before) return false;
  writeDocument(doc);
  return true;
}

export class ProfileValidationError extends Error {
  readonly problems: ProfileProblem[];
  constructor(problems: ProfileProblem[]) {
    super(`invalid profile: ${problems.join(', ')}`);
    this.problems = problems;
  }
}
