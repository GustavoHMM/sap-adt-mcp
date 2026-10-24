import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSapUrl, UrlError } from '../src/url.ts';

test('URL pasted from the browser is reduced to the origin, with notes', () => {
  const r = normalizeSapUrl('https://sapqas.corp.local:44300/sap/bc/adt/programs/programs/ztest?sap-client=400#x');
  assert.equal(r.origin, 'https://sapqas.corp.local:44300');
  assert.equal(r.client, '400');
  assert.equal(r.changed, true);
  assert.deepEqual(
    r.notes.map((n) => n.code),
    ['client-detected', 'query-removed', 'path-removed'],
  );
});

test('host:port without protocol becomes https', () => {
  const r = normalizeSapUrl('  sapdev:8443 ');
  assert.equal(r.origin, 'https://sapdev:8443');
  assert.ok(r.notes.some((n) => n.code === 'scheme-added'));
});

test('default ports are dropped and hosts lowercased, like the upstream expects', () => {
  assert.equal(normalizeSapUrl('https://SAP.Example.com:443/').origin, 'https://sap.example.com');
});

test('embedded credentials are removed and HTTP is flagged', () => {
  const r = normalizeSapUrl('http://user:secret@sap.example.com:8000');
  assert.equal(r.origin, 'http://sap.example.com:8000');
  assert.ok(r.notes.some((n) => n.code === 'credentials-removed'));
  assert.ok(r.notes.some((n) => n.code === 'insecure-http'));
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('an already clean origin is unchanged', () => {
  const r = normalizeSapUrl('https://sap.example.com:44300');
  assert.equal(r.changed, false);
  assert.deepEqual(r.notes, []);
});

test('garbage and other schemes are rejected', () => {
  assert.throws(() => normalizeSapUrl(''), (e: unknown) => e instanceof UrlError && e.code === 'empty');
  assert.throws(() => normalizeSapUrl('ftp://sap'), (e: unknown) => e instanceof UrlError && e.code === 'unsupported-scheme');
  assert.throws(() => normalizeSapUrl('https://'), UrlError);
});
