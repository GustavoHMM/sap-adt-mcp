import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { getPassword } from '@abap-adt-mcp/core/credentials';
import { getProfile } from '@abap-adt-mcp/core/profiles';
import { makeTlsFixture, tempHome, type TlsFixture } from '../../../packages/core/test/helpers/fixtures.ts';
import { deleteProfileEverywhere, listProfileViews, normalizeUrlView, saveProfileRequest, trustCertificateFor } from '../src/main/services.ts';
import type { Profile } from '../src/shared/api.ts';

const windows = process.platform === 'win32';
let home: string;
let fixture: TlsFixture;

const draft = (over: Partial<Profile> = {}): Profile => ({
  id: 'QAS400',
  name: 'QAS 400',
  url: 'https://sapqas.corp.local:44300',
  client: '400',
  username: 'gustavo',
  language: 'pt',
  environment: 'QAS',
  ...over,
});

before(() => {
  home = tempHome();
  fixture = makeTlsFixture();
});

after(async () => {
  await deleteProfileEverywhere('QAS400');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test('a pasted Eclipse/browser URL is explained in the app language', () => {
  const view = normalizeUrlView('sapqas.corp.local:44300/sap/bc/adt/programs?sap-client=400', 'pt');
  assert.equal(view.origin, 'https://sapqas.corp.local:44300');
  assert.equal(view.client, '400');
  assert.ok(view.notes.some((n) => n.includes('usei https://')));
  assert.equal(normalizeUrlView('ftp://x', 'en').error, 'unsupported-scheme');
});

test('a new profile needs a password and a free identifier', { skip: !windows }, () => {
  assert.deepEqual(saveProfileRequest({ isNew: true, profile: draft() }), { ok: false, problems: ['password-required'] });
  const saved = saveProfileRequest({ isNew: true, profile: draft(), password: 'segredo' });
  assert.equal(saved.ok, true);
  assert.equal(getProfile('QAS400')?.username, 'GUSTAVO');
  assert.equal(getProfile('QAS400')?.language, 'PT');
  assert.equal(getPassword('QAS400'), 'segredo');
  assert.deepEqual(saveProfileRequest({ isNew: true, profile: draft(), password: 'x' }), { ok: false, problems: ['id-taken'] });
});

test('editing keeps the saved password and ignores fields the window must not set', { skip: !windows }, () => {
  const sneaky = draft({ name: 'Renomeado', trustedCertificate: { file: 'C:\\evil.pem', fingerprint256: 'x', subject: 'x', validTo: 'x' }, proxy: { mode: 'manual', url: 'http://evil:8080' } });
  const r = saveProfileRequest({ isNew: false, profile: sneaky });
  assert.equal(r.ok, true);
  const stored = getProfile('QAS400')!;
  assert.equal(stored.name, 'Renomeado');
  assert.equal(stored.trustedCertificate, undefined);
  assert.equal(stored.proxy, undefined);
  assert.equal(getPassword('QAS400'), 'segredo');
  assert.equal(listProfileViews()[0]?.hasPassword, true);
});

test('validation problems come back for the form', { skip: !windows }, () => {
  const r = saveProfileRequest({ isNew: false, profile: draft({ client: '4', url: 'http://sap:8000', environment: 'PRD' }) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.problems.sort(), ['client', 'http-in-prd']);
});

test('trusting a certificate stores it for that profile only, checking the fingerprint', { skip: !windows }, () => {
  const pem = fs.readFileSync(fixture.certFile, 'utf8');
  assert.throws(() => trustCertificateFor('QAS400', pem, 'AA:BB'), /fingerprint mismatch/);
  const fingerprint = new X509Certificate(pem).fingerprint256;
  const view = trustCertificateFor('QAS400', pem, fingerprint);
  assert.equal(view.trustedCertificate?.fingerprint256, fingerprint);
  assert.equal(path.dirname(view.trustedCertificate!.file), path.join(home, 'certs'));
  assert.ok(fs.readFileSync(view.trustedCertificate!.file, 'utf8').includes('BEGIN CERTIFICATE'));
});

test('deleting removes the profile, its password and its certificate', { skip: !windows }, async () => {
  const certFile = getProfile('QAS400')!.trustedCertificate!.file;
  await deleteProfileEverywhere('QAS400');
  assert.equal(getProfile('QAS400'), undefined);
  assert.equal(getPassword('QAS400'), null);
  assert.equal(fs.existsSync(certFile), false);
});
