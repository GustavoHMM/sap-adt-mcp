import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before, test } from 'node:test';
import { tempHome } from './helpers/fixtures.ts';
import { profilesFile } from '../src/paths.ts';
import {
  effectiveDisabledTools,
  getProfile,
  loadProfiles,
  mcpServerName,
  ProfileValidationError,
  removeProfile,
  saveProfile,
  validateProfile,
  type Profile,
} from '../src/profiles.ts';

const base: Profile = {
  id: 'QAS400',
  name: 'Qualidade 400',
  url: 'https://sapqas.corp.local:44300',
  client: '400',
  username: 'GUSTAVO',
  language: 'PT',
  environment: 'QAS',
};

before(() => tempHome());

test('profiles are saved without secrets and found ignoring case', () => {
  saveProfile(base);
  assert.equal(getProfile('qas400')?.name, 'Qualidade 400');
  const text = fs.readFileSync(profilesFile(), 'utf8');
  assert.ok(!/password/i.test(text));
  saveProfile({ ...base, name: 'QAS renomeado' });
  assert.equal(loadProfiles().length, 1);
  assert.equal(getProfile('QAS400')?.name, 'QAS renomeado');
});

test('GetTableContents starts disabled in QAS and PRD, enabled in DEV', () => {
  assert.deepEqual([...effectiveDisabledTools(base)], ['GetTableContents']);
  assert.deepEqual([...effectiveDisabledTools({ ...base, environment: 'PRD' })], ['GetTableContents']);
  assert.deepEqual([...effectiveDisabledTools({ ...base, environment: 'DEV' })], []);
  assert.deepEqual([...effectiveDisabledTools({ ...base, disabledTools: [] })], []);
});

test('HTTP is blocked for PRD and needs explicit acceptance elsewhere', () => {
  const http = { ...base, url: 'http://sap.corp.local:8000' };
  assert.ok(validateProfile({ ...http, environment: 'PRD', allowInsecureHttp: true }).includes('http-in-prd'));
  assert.ok(validateProfile(http).includes('http-not-accepted'));
  assert.deepEqual(validateProfile({ ...http, allowInsecureHttp: true }), []);
});

test('invalid data is refused with every problem listed', () => {
  const bad = { ...base, id: 'has space', url: 'https://x/path', client: '4', username: 'a:b', language: 'POR' };
  assert.throws(
    () => saveProfile(bad),
    (e: unknown) =>
      e instanceof ProfileValidationError &&
      ['id', 'url', 'client', 'username', 'language'].every((p) => e.problems.includes(p as never)),
  );
});

test('MCP server names follow the profile id', () => {
  assert.equal(mcpServerName('QAS400'), 'abap-adt-QAS400');
});

test('profiles can be removed', () => {
  assert.equal(removeProfile('QAS400'), true);
  assert.equal(removeProfile('QAS400'), false);
  assert.equal(getProfile('QAS400'), undefined);
});
