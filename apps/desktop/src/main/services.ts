import fs from 'node:fs';
import path from 'node:path';
import { saveTrustedCertificate } from '@abap-adt-mcp/core/certs';
import { deletePassword, getPassword, setPassword } from '@abap-adt-mcp/core/credentials';
import { t, type Lang } from '@abap-adt-mcp/core/messages';
import { certsDir, stateDir } from '@abap-adt-mcp/core/paths';
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

/** Removes the profile together with its password, trusted certificate and usage record. */
export function deleteProfileEverywhere(id: string): void {
  const profile = getProfile(id);
  if (!profile) return;
  try {
    deletePassword(profile.id);
  } catch {
    // never saved
  }
  removeProfile(profile.id);
  for (const file of [path.join(certsDir(), `${profile.id}.pem`), path.join(stateDir(), `serve-${profile.id}.json`)]) {
    fs.rmSync(file, { force: true });
  }
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
