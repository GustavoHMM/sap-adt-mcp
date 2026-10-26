import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

/**
 * Temporary app home, credential namespace and Windows profile folders, so
 * tests never touch real profiles, passwords or Claude configs, never restart
 * Claude, and never reach the internet (no Claude reachability check).
 */
export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abap-adt-mcp-test-'));
  const windowsProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'abap-adt-mcp-winprofile-'));
  for (const sub of ['Local', 'Roaming', 'User']) fs.mkdirSync(path.join(windowsProfile, sub));
  process.env.ABAP_ADT_MCP_HOME = dir;
  process.env.LOCALAPPDATA = path.join(windowsProfile, 'Local');
  process.env.APPDATA = path.join(windowsProfile, 'Roaming');
  process.env.USERPROFILE = path.join(windowsProfile, 'User');
  // Electron crashes with a fake USERPROFILE, so window tests restore it; Claude Code
  // detection then still lands here through CLAUDE_CONFIG_DIR. Never run the real CLI.
  process.env.CLAUDE_CONFIG_DIR = path.join(windowsProfile, 'User');
  process.env.ABAP_ADT_MCP_CLAUDE_CLI = 'none';
  process.env.ABAP_ADT_MCP_CREDENTIAL_NAMESPACE = 'test';
  process.env.ABAP_ADT_MCP_CLAUDE_CHECK = 'off';
  process.env.ABAP_ADT_MCP_DISABLE_CLAUDE_RESTART = '1';
  return dir;
}

const OPENSSL_CANDIDATES = [
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\clangarm64\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
];

function findOpenssl(): string {
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error('openssl not found (Git for Windows ships one)');
}

export interface TlsFixture {
  dir: string;
  certFile: string;
  key: Buffer;
  cert: Buffer;
}

/** Self-signed certificate for localhost and 127.0.0.1, like the upstream's own tests. */
export function makeTlsFixture(): TlsFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abap-adt-mcp-tls-'));
  execFileSync(
    findOpenssl(),
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  return {
    dir,
    certFile: path.join(dir, 'cert.pem'),
    key: fs.readFileSync(path.join(dir, 'key.pem')),
    cert: fs.readFileSync(path.join(dir, 'cert.pem')),
  };
}

export type AdtMode = 'ok' | '403' | '404' | 'redirect' | '500';

export interface AdtRequest {
  method: string;
  path: string;
  client: string | null;
  language: string | null;
  authOk: boolean;
}

export interface AdtMock {
  origin: string;
  port: number;
  requests: AdtRequest[];
  mode: AdtMode;
  close(): Promise<void>;
}

/** Minimal ADT endpoints with Basic auth, sap-client, CSRF and failure modes. */
export async function startAdtMock(tlsFixture: TlsFixture, user: string, password: string): Promise<AdtMock> {
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const mock: AdtMock = { origin: '', port: 0, requests: [], mode: 'ok', close: async () => undefined };
  const server = https.createServer({ key: tlsFixture.key, cert: tlsFixture.cert }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    const authOk = req.headers.authorization === expected;
    mock.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      client: url.searchParams.get('sap-client'),
      language: url.searchParams.get('sap-language'),
      authOk,
    });
    if (mock.mode === '403') return void res.writeHead(403).end('forbidden');
    if (mock.mode === '500') return void res.writeHead(500).end('dump');
    if (mock.mode === 'redirect') {
      return void res.writeHead(302, { location: `https://127.0.0.1:${mock.port}${url.pathname}` }).end();
    }
    if (!authOk) return void res.writeHead(401, { 'www-authenticate': 'Basic realm="SAP NetWeaver Application Server [MCK/400]"' }).end();
    if (url.pathname === '/sap/bc/adt/discovery') {
      if (mock.mode === '404') return void res.writeHead(404).end();
      const headers: Record<string, string> = { 'content-type': 'application/atomsvc+xml', 'set-cookie': 'SAP_SESSIONID_MCK_400=fixture; path=/' };
      if (req.headers['x-csrf-token'] === 'fetch') headers['x-csrf-token'] = 'fixture-token';
      return void res.writeHead(200, headers).end('<app:service xmlns:app="http://www.w3.org/2007/app"/>');
    }
    if (url.pathname === '/sap/bc/adt/repository/informationsystem/search') {
      return void res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(`<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:name="${url.searchParams.get('query')}" adtcore:type="CLAS/OC"/></adtcore:objectReferences>`);
    }
    if (url.pathname === '/sap/bc/adt/programs/programs/ZFIXTURE/source/main') {
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end("REPORT zfixture.\nWRITE: / 'Olá'.");
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  mock.port = (server.address() as net.AddressInfo).port;
  mock.origin = `https://localhost:${mock.port}`;
  mock.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return mock;
}

export interface ConnectProxy {
  url: string;
  connects: string[];
  plainRequests: string[];
  close(): Promise<void>;
}

/** HTTP proxy that only tunnels (CONNECT); it can demand NTLM like corporate proxies do. */
export async function startConnectProxy(options: { requireNtlm?: boolean } = {}): Promise<ConnectProxy> {
  const proxy: ConnectProxy = { url: '', connects: [], plainRequests: [], close: async () => undefined };
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    proxy.plainRequests.push(`${req.method} ${req.url}`);
    res.writeHead(502).end();
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    proxy.connects.push(req.url ?? '');
    if (options.requireNtlm) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: NTLM\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = (req.url ?? '').split(/:(?=\d+$)/);
    const upstream = net.connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  proxy.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  proxy.close = async () => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return proxy;
}

export const uniqueId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
