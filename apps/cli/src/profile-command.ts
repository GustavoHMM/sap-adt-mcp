import { credentialTarget, deletePassword, getPassword, setPassword } from '@abap-adt-mcp/core/credentials';
import { defaultSapLanguage, t, type Lang } from '@abap-adt-mcp/core/messages';
import {
  ENVIRONMENTS,
  getProfile,
  loadProfiles,
  mcpServerName,
  ProfileValidationError,
  removeProfile,
  saveProfile,
  type Environment,
  type Profile,
} from '@abap-adt-mcp/core/profiles';
import { normalizeSapUrl } from '@abap-adt-mcp/core/url';
import { readAllStdin, readHidden } from './prompt.ts';

export class UsageError extends Error {}

type Options = Record<string, string | boolean | undefined>;

const required = (options: Options, name: string, lang: Lang): string => {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(t(lang, 'cli.missingOption', { option: name }));
  return value.trim();
};

export function findProfileOrThrow(id: string, lang: Lang): Profile {
  const profile = getProfile(id);
  if (!profile) {
    const list = loadProfiles().map((p) => p.id).join(', ') || t(lang, 'cli.noProfiles');
    throw new UsageError(t(lang, 'cli.profileNotFound', { profile: id, list }));
  }
  return profile;
}

export function addProfile(options: Options, lang: Lang): void {
  const normalized = normalizeSapUrl(required(options, 'url', lang));
  for (const note of normalized.notes) process.stdout.write(`  ${t(lang, `url.${note.code}`, 'value' in note ? { value: note.value } : {})}\n`);
  const env = required(options, 'env', lang).toUpperCase() as Environment;
  const profile: Profile = {
    id: required(options, 'id', lang),
    name: required(options, 'name', lang),
    url: normalized.origin,
    client: typeof options.client === 'string' ? options.client : (normalized.client ?? ''),
    username: required(options, 'user', lang).toUpperCase(),
    language: typeof options.lang === 'string' ? options.lang.toUpperCase() : defaultSapLanguage(),
    environment: ENVIRONMENTS.includes(env) ? env : (env as Environment),
    allowInsecureHttp: options['allow-http'] === true || undefined,
  };
  const existing = getProfile(profile.id);
  if (existing) {
    profile.disabledTools = existing.disabledTools;
    profile.proxy = existing.proxy;
    profile.trustedCertificate = existing.trustedCertificate;
  }
  try {
    saveProfile(profile);
  } catch (e) {
    if (e instanceof ProfileValidationError) throw new UsageError(t(lang, 'cli.profileInvalid', { problems: e.problems.join(', ') }));
    throw e;
  }
  process.stdout.write(t(lang, 'cli.profileSaved', { profile: profile.id, server: mcpServerName(profile.id) }) + '\n');
  if (!safeHasPassword(profile)) process.stdout.write(t(lang, 'cli.passwordMissingHint', { profile: profile.id }) + '\n');
}

export function listProfiles(lang: Lang): void {
  const profiles = loadProfiles();
  if (!profiles.length) {
    process.stdout.write(t(lang, 'cli.noProfiles') + '\n');
    return;
  }
  for (const p of profiles) {
    const key = safeHasPassword(p) ? '🔑' : '  ';
    process.stdout.write(`${key} ${p.id.padEnd(12)} ${p.environment}  ${p.url}  client ${p.client}  ${p.name}\n`);
  }
}

export function showProfile(id: string, lang: Lang): void {
  const p = findProfileOrThrow(id, lang);
  const view = { ...p, mcpServer: mcpServerName(p.id), credential: credentialTarget(p.id), passwordSaved: safeHasPassword(p) };
  process.stdout.write(JSON.stringify(view, null, 2) + '\n');
}

export function deleteProfile(id: string, lang: Lang): void {
  const p = findProfileOrThrow(id, lang);
  try {
    deletePassword(p.id);
  } catch {
    // The password may never have been saved.
  }
  removeProfile(p.id);
  process.stdout.write(t(lang, 'cli.profileRemoved', { profile: p.id }) + '\n');
}

export async function setProfilePassword(id: string, fromStdin: boolean, lang: Lang): Promise<void> {
  const p = findProfileOrThrow(id, lang);
  const password = fromStdin ? await readAllStdin() : await readHidden(t(lang, 'cli.passwordPrompt', { user: p.username, profile: p.id }));
  if (!password) {
    process.stdout.write(t(lang, 'cli.passwordEmpty') + '\n');
    return;
  }
  setPassword(p.id, password);
  process.stdout.write(t(lang, 'cli.passwordSaved', { target: credentialTarget(p.id) }) + '\n');
}

function safeHasPassword(p: Profile): boolean {
  try {
    return getPassword(p.id) !== null;
  } catch {
    return false;
  }
}
