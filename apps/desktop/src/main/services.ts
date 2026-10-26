import fs from 'node:fs';
import path from 'node:path';
import { saveTrustedCertificate } from '@abap-adt-mcp/core/certs';
import { deletePassword, getPassword, setPassword } from '@abap-adt-mcp/core/credentials';
import { t, type Lang } from '@abap-adt-mcp/core/messages';
import { disconnectProfile, forgetProfile } from '@abap-adt-mcp/core/claude/integration';
import { certsDir } from '@abap-adt-mcp/core/paths';
import { removeServeRecords } from '@abap-adt-mcp/core/state';
import {
  effectiveDisabledTools,
  getProfile,
  loadProfiles,
  mcpServerName,
  removeProfile,
  saveProfile,
  validateProfile,
  type Profile,
} from '@abap-adt-mcp/core/profiles';
import { normalizeSapUrl, UrlError } from '@abap-adt-mcp/core/url';
import type { ProfileView, SaveProfileRequest, SaveProfileResult, UrlView } from '../shared/api.ts';
import { TOOLS } from '@abap-adt-mcp/core/tools';

function hasPassword(id: string): boolean {
  try {
    return getPassword(id) !== null;
  } catch {
    return false;
  }
}

export function toView(p: Profile): ProfileView {
  return { ...p, hasPassword: hasPassword(p.id), disabledToolsEffective: [...effectiveDisabledTools(p)], mcpServer: mcpServerName(p.id) };
}

export function listProfileViews(): ProfileView[] {
  return loadProfiles().map(toView);
}

export function normalizeUrlView(text: string, lang: Lang): UrlView {
  try {
    const r = normalizeSapUrl(text);
    return {
      ok: true,
      origin: r.origin,
      client: r.client,
      insecure: r.origin.startsWith('http:'),
      notes: r.notes.map((n) => t(lang, `url.${n.code}`, 'value' in n ? { value: n.value } : {})),
    };
  } catch (e) {
    if (e instanceof UrlError) return { ok: false, notes: [], error: e.code };
    throw e;
  }
}

/**
 * Saves what the person typed. Fields the window must not control (trusted
 * certificate file, proxy) always come from what is already on disk.
 */
export function saveProfileRequest(request: SaveProfileRequest): SaveProfileResult {
  const input = request.profile;
  const existing = getProfile(input.id);
  if (request.isNew && existing) return { ok: false, problems: ['id-taken'] };
  if (!request.isNew && !existing) return { ok: false, problems: ['id'] };
  const password = request.password ?? '';
  if (request.isNew && !password) return { ok: false, problems: ['password-required'] };

  const profile: Profile = {
    id: existing?.id ?? input.id.trim(),
    name: input.name.trim(),
    url: input.url.trim(),
    client: input.client.trim(),
    username: input.username.trim().toUpperCase(),
    language: input.language?.trim() ? input.language.trim().toUpperCase() : undefined,
    environment: input.environment,
    disabledTools: Array.isArray(input.disabledTools) ? input.disabledTools.filter((x) => typeof x === 'string') : existing?.disabledTools,
    // Never from the window: losing it would switch a business-data tool the person enabled back off.
    knownTools: existing?.knownTools,
    proxy: existing?.proxy,
    trustedCertificate: existing?.trustedCertificate,
    allowInsecureHttp: input.allowInsecureHttp === true ? true : undefined,
  };
  const problems = validateProfile(profile);
  if (problems.length) return { ok: false, problems };
  saveProfile(profile);
  if (password) setPassword(profile.id, password);
  return { ok: true, profile: toView(profile) };
}

/** Removes the profile together with its Claude entries, password, trusted certificate and usage records. */
export async function deleteProfileEverywhere(id: string): Promise<{ restartSuggested: boolean }> {
  const profile = getProfile(id);
  if (!profile) return { restartSuggested: false };
  let restartSuggested = false;
  for (const kind of ['desktop', 'code'] as const) {
    try {
      restartSuggested = (await disconnectProfile(profile.id, kind)).restartSuggested || restartSuggested;
    } catch {
      // A broken Claude config must not keep the profile alive; status will show it.
    }
  }
  forgetProfile(profile.id);
  try {
    deletePassword(profile.id);
  } catch {
    // never saved
  }
  removeProfile(profile.id);
  fs.rmSync(path.join(certsDir(), `${profile.id}.pem`), { force: true });
  removeServeRecords(profile.id);
  return { restartSuggested };
}

/** Tools hidden from Claude for this profile; names must be strings, unknown ones are kept (future upstream tools). */
export function setDisabledTools(id: string, tools: unknown): ProfileView {
  const profile = getProfile(id);
  if (!profile) throw new Error('unknown profile');
  const list = Array.isArray(tools) ? [...new Set(tools.filter((t): t is string => typeof t === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(t)))] : [];
  // knownTools: tools added later that read business data start disabled for this choice.
  const updated = { ...profile, disabledTools: list, knownTools: TOOLS.map((t) => t.name) };
  saveProfile(updated);
  return toView(updated);
}

export function setProfilePassword(id: string, password: string): void {
  const profile = getProfile(id);
  if (!profile) throw new Error('unknown profile');
  if (!password) throw new Error('empty password');
  setPassword(profile.id, password);
}

export function trustCertificateFor(id: string, pem: string, fingerprint256: string): ProfileView {
  const profile = getProfile(id);
  if (!profile) throw new Error('unknown profile');
  const trusted = saveTrustedCertificate(profile.id, pem, fingerprint256);
  const updated = { ...profile, trustedCertificate: trusted };
  saveProfile(updated);
  return toView(updated);
}
