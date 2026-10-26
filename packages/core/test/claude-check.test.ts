import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { makeTlsFixture, startConnectProxy, tempHome, type TlsFixture } from './helpers/fixtures.ts';
import { checkClaudeAccess } from '../src/claude-check.ts';

// A local HTTPS server stands in for Anthropic; its self-signed certificate plays
// the role of a company CA that re-signs traffic (as on a corporate VPN).
let fixture: TlsFixture;
let server: https.Server;
let url = '';

before(async () => {
  tempHome();
  fixture = makeTlsFixture();
  server = https.createServer({ key: fixture.key, cert: fixture.cert }, (_req, res) => res.writeHead(404).end('{}'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `https://localhost:${(server.address() as net.AddressInfo).port}/`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

const direct = { mode: 'direct' } as const;

test('traffic re-signed by a CA this Windows does not trust is reported with a text for IT', async () => {
  const r = await checkClaudeAccess({ urls: [url], proxy: direct });
  assert.equal(r.step, 'claude');
  assert.equal(r.status, 'warn');
  assert.deepEqual(r.lines.map((l) => l.key), ['test.claude.inspected', 'test.claude.inspectedCa', 'test.claude.inspectedAction', 'it.claudeInspected']);
  assert.equal(r.lines[0]?.vars?.issuer, 'localhost');
  assert.match(String(r.lines[1]?.vars?.fingerprint), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('a company CA that Windows already trusts works, and is mentioned', async () => {
  const r = await checkClaudeAccess({ urls: [url], proxy: direct, extraCa: [fixture.cert.toString()] });
  assert.equal(r.status, 'ok');
  assert.equal(r.lines[0]?.key, 'test.claude.okInspected');
});

test('an unreachable Claude endpoint points to the network or VPN', async () => {
  const r = await checkClaudeAccess({ urls: ['https://localhost:9/'], proxy: direct, timeoutMs: 3000 });
  assert.equal(r.status, 'warn');
  assert.deepEqual(r.lines.map((l) => l.key), ['test.claude.unreachable', 'test.claude.unreachableAction', 'it.claudeBlocked']);
});

test('a proxy that demands Windows authentication is explained', async () => {
  const proxy = await startConnectProxy({ requireNtlm: true });
  try {
    const r = await checkClaudeAccess({ urls: [url], proxy: { mode: 'manual', url: proxy.url } });
    assert.equal(r.lines[0]?.key, 'test.claude.proxyAuth');
    assert.ok(proxy.connects.includes(new URL(url).host));
  } finally {
    await proxy.close();
  }
});

test('through a plain proxy the check tunnels with CONNECT', async () => {
  const proxy = await startConnectProxy();
  try {
    const r = await checkClaudeAccess({ urls: [url], proxy: { mode: 'manual', url: proxy.url }, extraCa: [fixture.cert.toString()] });
    assert.equal(r.status, 'ok');
    assert.deepEqual(proxy.plainRequests, []);
  } finally {
    await proxy.close();
  }
});
