import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { bypassesProxy, pickProxy } from '../src/proxy/parse.ts';
import { resolveProxy } from '../src/proxy/resolve.ts';
import { getProxyForUrl } from '../src/proxy/winhttp.ts';

test('proxy lists are read the way Windows reads them', () => {
  assert.equal(pickProxy('proxy.corp:8080', 'https'), 'http://proxy.corp:8080');
  assert.equal(pickProxy('http=a:80;https=b:3128', 'https'), 'http://b:3128');
  assert.equal(pickProxy('http=a:8080;https=b:3128', 'http'), 'http://a:8080');
  assert.equal(pickProxy('a:80', 'http'), 'http://a', 'default port is implied');
  assert.equal(pickProxy('http=a:80', 'https'), null);
  assert.equal(pickProxy('p1:3128; p2:3128', 'https'), 'http://p1:3128');
  assert.equal(pickProxy('socks=s:1080', 'https'), null);
  assert.equal(pickProxy('https://secure-proxy:443', 'https'), 'https://secure-proxy');
  assert.equal(pickProxy(null, 'https'), null);
});

test('bypass list follows <local>, wildcards and the implicit loopback rule', () => {
  assert.equal(bypassesProxy('sapqas', '<local>'), true);
  assert.equal(bypassesProxy('sapqas.corp.local', '<local>'), false);
  assert.equal(bypassesProxy('sapqas.corp.local', '*.corp.local;<local>'), true);
  assert.equal(bypassesProxy('SAPQAS.CORP.LOCAL', 'https://*.corp.local:443'), true);
  assert.equal(bypassesProxy('10.1.2.3', '10.*'), true);
  assert.equal(bypassesProxy('sap.example.com', '*.corp.local'), false);
  assert.equal(bypassesProxy('localhost', null), true);
  assert.equal(bypassesProxy('127.0.0.1', ''), true);
});

test('profile settings override Windows', () => {
  assert.deepEqual(resolveProxy('https://sap:443', { mode: 'direct' }), { proxyUrl: null, source: 'profile-direct' });
  assert.deepEqual(resolveProxy('https://sap:443', { mode: 'manual', url: 'http://p:3128' }), {
    proxyUrl: 'http://p:3128',
    source: 'profile-manual',
  });
});

// WinHTTP evaluates the PAC itself. The script is served by another process
// because the WinHTTP call blocks this one.
const windows = process.platform === 'win32';
let pacServer: ReturnType<typeof spawn> | undefined;
let pacUrl = '';

before(async () => {
  if (!windows) return;
  const script = `
    const pac = 'function FindProxyForURL(url, host) { if (shExpMatch(host, "*.direct.test")) return "DIRECT"; return "PROXY proxy.corp.test:3128; DIRECT"; }';
    const s = require('http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' }); r.end(pac); });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`;
  pacServer = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((resolve) => pacServer!.stdout!.once('data', (d) => resolve(String(d).trim())));
  pacUrl = `http://127.0.0.1:${port}/proxy.pac`;
});

after(() => pacServer?.kill());

test('Windows evaluates a PAC script for the SAP URL', { skip: !windows }, () => {
  const viaProxy = getProxyForUrl('https://sap.corp.test:44300/', { autoDetect: false, pacUrl });
  assert.deepEqual(viaProxy, { ok: true, proxy: 'proxy.corp.test:3128', bypass: null });
  const direct = getProxyForUrl('https://sap.direct.test/', { autoDetect: false, pacUrl });
  assert.deepEqual(direct, { ok: true, proxy: null, bypass: null });
  assert.deepEqual(resolveProxy('https://sap.corp.test:44300', { mode: 'pac', url: pacUrl }), {
    proxyUrl: 'http://proxy.corp.test:3128',
    source: 'profile-pac',
  });
});

test('an unreachable PAC script falls back to a direct connection with a warning', { skip: !windows }, () => {
  const r = resolveProxy('https://sap.corp.test', { mode: 'pac', url: 'http://127.0.0.1:9/none.pac' });
  assert.equal(r.proxyUrl, null);
  assert.equal(r.warning, 'pac-download-failed');
});

test('the system proxy settings can always be read', { skip: !windows }, () => {
  const r = resolveProxy('https://sap.example.com');
  assert.ok(['system-pac', 'system-wpad', 'system-static', 'system-none'].includes(r.source));
});
