import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeTlsFixture, startAdtMock, startConnectProxy, tempHome, type AdtMock, type TlsFixture } from './helpers/fixtures.ts';
import { runConnectionTest, type StepResult } from '../src/probe.ts';
import type { Profile } from '../src/profiles.ts';

let fixture: TlsFixture;
let mock: AdtMock;
let profile: Profile;

before(async () => {
  tempHome();
  fixture = makeTlsFixture();
  mock = await startAdtMock(fixture, 'TESTER', 'secret-1');
  profile = {
    id: 'MCK400',
    name: 'Mock',
    url: mock.origin,
    client: '400',
    username: 'TESTER',
    language: 'PT',
    environment: 'QAS',
    proxy: { mode: 'direct' },
    trustedCertificate: { file: fixture.certFile, fingerprint256: '', subject: 'CN=localhost', validTo: '' },
  };
});

after(async () => {
  await mock.close();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

const statuses = (results: StepResult[]) => Object.fromEntries(results.map((r) => [r.step, r.status]));
const step = (results: StepResult[], id: StepResult['step']) => results.find((r) => r.step === id)!;

test('every step passes against a healthy ADT service, with sap-client and language sent', async () => {
  mock.mode = 'ok';
  mock.requests.length = 0;
  const results = await runConnectionTest({ profile, password: 'secret-1' });
  assert.deepEqual(statuses(results), { url: 'ok', proxy: 'ok', dns: 'ok', tcp: 'ok', tls: 'ok', adt: 'ok', csrf: 'ok', mcp: 'skip' });
  assert.deepEqual(mock.requests, [{ method: 'GET', path: '/sap/bc/adt/discovery', client: '400', language: 'PT', authOk: true }]);
});

test('an untrusted certificate stops the test and offers the certificate details', async () => {
  const results = await runConnectionTest({ profile: { ...profile, trustedCertificate: undefined }, password: 'secret-1' });
  const tls = step(results, 'tls');
  assert.equal(tls.status, 'fail');
  assert.equal(tls.lines[0]?.key, 'test.tls.untrusted');
  const offered = (tls.data?.certificate as { fingerprint256: string; pem: string }) ?? {};
  const expected = execFileSync(process.execPath, ['-e', `console.log(new (require('crypto').X509Certificate)(require('fs').readFileSync(${JSON.stringify(fixture.certFile)})).fingerprint256)`], { encoding: 'utf8' }).trim();
  assert.equal(offered.fingerprint256, expected);
  assert.match(offered.pem, /BEGIN CERTIFICATE/);
  assert.equal(step(results, 'adt').status, 'skip');
});

test('a certificate for another name explains which names it is valid for', async () => {
  const other = makeTlsFixtureWithoutIp();
  const ipMock = await startAdtMock(other, 'TESTER', 'secret-1');
  try {
    const results = await runConnectionTest({
      profile: { ...profile, url: `https://127.0.0.1:${ipMock.port}`, trustedCertificate: { ...profile.trustedCertificate!, file: other.certFile } },
      password: 'secret-1',
    });
    const tls = step(results, 'tls');
    assert.equal(tls.lines[0]?.key, 'test.tls.hostname');
    assert.deepEqual(tls.data?.certificateNames, ['localhost']);
  } finally {
    await ipMock.close();
  }
});

test('wrong password, missing authorization, inactive service and redirects are explained', async () => {
  mock.mode = 'ok';
  let results = await runConnectionTest({ profile, password: 'wrong' });
  assert.deepEqual(step(results, 'adt').lines.map((l) => l.key), ['test.adt.401', 'test.adt.401action']);

  mock.mode = '403';
  results = await runConnectionTest({ profile, password: 'secret-1' });
  assert.deepEqual(step(results, 'adt').lines.map((l) => l.key), ['test.adt.403', 'basis.403']);
  assert.equal(step(results, 'adt').lines[1]?.vars?.user, 'TESTER');

  mock.mode = '404';
  results = await runConnectionTest({ profile, password: 'secret-1' });
  assert.deepEqual(step(results, 'adt').lines.map((l) => l.key), ['test.adt.404', 'basis.404']);

  mock.mode = 'redirect';
  results = await runConnectionTest({ profile, password: 'secret-1' });
  assert.equal(step(results, 'adt').data?.redirectOrigin, `https://127.0.0.1:${mock.port}`);
  mock.mode = 'ok';
});

test('no saved password stops before contacting SAP with credentials', async () => {
  mock.requests.length = 0;
  const results = await runConnectionTest({ profile, password: null });
  assert.equal(step(results, 'adt').lines[0]?.key, 'relay.noPassword');
  assert.equal(mock.requests.length, 0);
});

test('through a proxy the SAP traffic is tunnelled end to end', async () => {
  const proxy = await startConnectProxy();
  try {
    const results = await runConnectionTest({ profile: { ...profile, proxy: { mode: 'manual', url: proxy.url } }, password: 'secret-1' });
    assert.deepEqual(statuses(results), { url: 'ok', proxy: 'ok', dns: 'ok', tcp: 'ok', tls: 'ok', adt: 'ok', csrf: 'ok', mcp: 'skip' });
    assert.ok(proxy.connects.every((c) => c === `localhost:${mock.port}`) && proxy.connects.length >= 3);
    assert.deepEqual(proxy.plainRequests, []);
  } finally {
    await proxy.close();
  }
});

test('a proxy demanding Windows authentication is reported clearly', async () => {
  const proxy = await startConnectProxy({ requireNtlm: true });
  try {
    const results = await runConnectionTest({ profile: { ...profile, proxy: { mode: 'manual', url: proxy.url } }, password: 'secret-1' });
    assert.equal(step(results, 'tcp').lines[0]?.key, 'test.tcp.proxyAuth');
    assert.equal(step(results, 'tcp').lines[0]?.vars?.scheme, 'NTLM');
  } finally {
    await proxy.close();
  }
});

test('unknown hosts and closed ports point to the VPN and network', async () => {
  let results = await runConnectionTest({ profile: { ...profile, url: 'https://sap-does-not-exist.invalid' }, password: 'x' });
  assert.deepEqual(step(results, 'dns').lines.map((l) => l.key), ['test.dns.fail', 'test.dns.action']);
  results = await runConnectionTest({ profile: { ...profile, url: 'https://localhost:9' }, password: 'x', timeoutMs: 3000 });
  assert.equal(step(results, 'tcp').lines[0]?.key, 'test.tcp.fail');
});

test('HTTP in a production profile is blocked before any connection', async () => {
  const results = await runConnectionTest({ profile: { ...profile, url: 'http://localhost:8000', environment: 'PRD' }, password: 'x' });
  assert.equal(results[0]?.lines[0]?.key, 'test.url.httpPrd');
  assert.ok(results.slice(1).every((r) => r.status === 'skip'));
});

function makeTlsFixtureWithoutIp(): TlsFixture {
  // Same as makeTlsFixture but valid only for "localhost", to provoke a name mismatch on 127.0.0.1.
  const f = makeTlsFixture();
  const openssl = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\clangarm64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'].find((c) => {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })!;
  execFileSync(
    openssl,
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(f.dir, 'key.pem'), '-out', path.join(f.dir, 'cert.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
    { stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  return { ...f, key: fs.readFileSync(path.join(f.dir, 'key.pem')), cert: fs.readFileSync(path.join(f.dir, 'cert.pem')) };
}
