import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { commonName, summarizeCertificate } from './certs.ts';
import type { StepLine, StepResult } from './probe.ts';
import type { ProxySetting } from './profiles.ts';
import { resolveProxy } from './proxy/resolve.ts';
import { APP_VERSION } from './version.ts';

/** Where Claude (Desktop and Code) must be able to connect from this computer. */
export const CLAUDE_URLS = ['https://api.anthropic.com/', 'https://claude.ai/'];

interface HostResult {
  host: string;
  url: string;
  proxyUrl: string | null;
  /** 'ok', or why Claude would fail from this network. */
  outcome: 'ok' | 'dns' | 'connect' | 'proxy-auth' | 'proxy-denied' | 'inspected' | 'tls';
  code?: string;
  issuer?: string;
  /** TLS inspection the computer already trusts: works, but worth knowing. */
  inspectedButTrusted?: boolean;
  status?: number;
  inspectingCa?: { subject: string; fingerprint256: string; validTo: string };
}

/** Public roots the Anthropic endpoints are known to use; anything else means a proxy re-signed the traffic. */
const PUBLIC_ISSUERS = /Google Trust Services|Let's Encrypt|DigiCert|Sectigo|GlobalSign|Amazon|Cloudflare|Baltimore|ISRG/i;

const errCode = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

function connect(target: URL, proxy: URL | undefined, timeout: number): Promise<net.Socket> {
  const port = Number(target.port) || 443;
  if (!proxy) {
    return withTimeout(
      new Promise((resolve, reject) => {
        const s = net.connect({ host: target.hostname, port });
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      }),
      timeout,
    );
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}`, 'user-agent': `abap-adt-mcp/${APP_VERSION}` },
      timeout,
      agent: false,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(Object.assign(new Error(`proxy ${res.statusCode}`), { code: res.statusCode === 407 ? 'PROXY_AUTH' : `PROXY_${res.statusCode}` }));
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
    req.once('error', reject);
    req.end();
  });
}

async function checkHost(url: string, ca: string[], timeout: number, proxySetting: ProxySetting): Promise<HostResult> {
  const target = new URL(url);
  let proxyUrl: string | null = null;
  try {
    proxyUrl = resolveProxy(target.origin, proxySetting).proxyUrl;
  } catch {
    proxyUrl = null;
  }
  const proxy = proxyUrl ? new URL(proxyUrl) : undefined;
  const result: HostResult = { host: target.hostname, url, proxyUrl, outcome: 'ok' };

  if (!proxy) {
    try {
      await withTimeout(dns.lookup(target.hostname), timeout);
    } catch (e) {
      return { ...result, outcome: 'dns', code: errCode(e) };
    }
  }

  let socket: net.Socket;
  try {
    socket = await connect(target, proxy, timeout);
  } catch (e) {
    const code = errCode(e);
    if (code === 'PROXY_AUTH') return { ...result, outcome: 'proxy-auth', code };
    if (code.startsWith('PROXY_')) return { ...result, outcome: 'proxy-denied', code };
    return { ...result, outcome: 'connect', code };
  }

  // Handshake only, to read who signed the certificate; nothing is sent on this connection.
  let peer: tls.DetailedPeerCertificate;
  let authorized: boolean;
  let authorizationError: string | undefined;
  try {
    const s = await withTimeout(
      new Promise<tls.TLSSocket>((resolve, reject) => {
        const c = tls.connect({ socket, servername: target.hostname, ca, rejectUnauthorized: false });
        c.once('secureConnect', () => resolve(c));
        c.once('error', reject);
      }),
      timeout,
    );
    peer = s.getPeerCertificate(true);
    authorized = s.authorized;
    authorizationError = s.authorizationError ? String(s.authorizationError) : undefined;
    s.destroy();
  } catch (e) {
    return { ...result, outcome: 'tls', code: errCode(e) };
  }
  const issuer = summarizeCertificate(peer.raw).issuer;
  result.issuer = commonName(issuer);
  const reSigned = !PUBLIC_ISSUERS.test(issuer);

  if (!authorized) {
    let top = peer;
    const seen = new Set<string>();
    while (top.issuerCertificate && top.issuerCertificate !== top && !seen.has(top.fingerprint256)) {
      seen.add(top.fingerprint256);
      top = top.issuerCertificate;
    }
    const ca = summarizeCertificate(top.raw);
    return {
      ...result,
      outcome: reSigned ? 'inspected' : 'tls',
      code: authorizationError,
      inspectingCa: { subject: ca.subject, fingerprint256: ca.fingerprint256, validTo: ca.validTo },
    };
  }
  result.inspectedButTrusted = reSigned;

  // One anonymous request through the same path Claude would use.
  try {
    const agent = new https.Agent({ ca, keepAlive: false, ...(proxyUrl ? { proxyEnv: { HTTPS_PROXY: proxyUrl, NO_PROXY: '' } } : {}) });
    result.status = await withTimeout(
      new Promise<number>((resolve, reject) => {
        const req = https.request(url, { method: 'GET', agent, headers: { 'user-agent': `abap-adt-mcp/${APP_VERSION}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.once('error', reject);
        req.end();
      }),
      timeout,
    );
    agent.destroy();
  } catch {
    // The handshake already proved the path; the status is only informative.
  }
  return result;
}

/**
 * Checks, from this computer and network, whether Claude itself can reach
 * Anthropic: corporate VPNs often block it or re-sign it with a company CA
 * that Windows does not trust. Only DNS, TCP, a TLS handshake and one
 * anonymous GET; no data about the person or SAP is sent.
 */
export async function checkClaudeAccess(
  options: { urls?: string[]; extraCa?: string[]; timeoutMs?: number; proxy?: ProxySetting } = {},
): Promise<StepResult> {
  const urls = options.urls ?? CLAUDE_URLS;
  const ca = [...tls.getCACertificates('bundled'), ...tls.getCACertificates('system'), ...(options.extraCa ?? [])];
  const proxy = options.proxy ?? { mode: 'system' };
  const results = await Promise.all(urls.map((u) => checkHost(u, ca, options.timeoutMs ?? 8000, proxy)));
  const hosts = results.map((r) => r.host).join(', ');
  const bad = results.find((r) => r.outcome !== 'ok');
  const main = (key: StepLine['key'], vars?: StepLine['vars']): StepLine => ({ key, vars, kind: 'main' });
  const line = (kind: StepLine['kind'], key: StepLine['key'], vars?: StepLine['vars']): StepLine => ({ key, vars, kind });
  const data = { hosts: results };

  if (!bad) {
    const inspected = results.find((r) => r.inspectedButTrusted);
    if (inspected) return { step: 'claude', status: 'ok', lines: [main('test.claude.okInspected', { issuer: inspected.issuer ?? '?' })], data };
    return { step: 'claude', status: 'ok', lines: [main('test.claude.ok', { hosts })], data };
  }

  const itVars = { hosts };
  switch (bad.outcome) {
    case 'inspected':
      return {
        step: 'claude',
        status: 'warn',
        lines: [
          main('test.claude.inspected', { host: bad.host, issuer: bad.issuer ?? '?' }),
          line('detail', 'test.claude.inspectedCa', { subject: bad.inspectingCa?.subject ?? '?', fingerprint: bad.inspectingCa?.fingerprint256 ?? '?' }),
          line('action', 'test.claude.inspectedAction'),
          line('it', 'it.claudeInspected', { ...itVars, issuer: bad.issuer ?? '?' }),
        ],
        data,
      };
    case 'proxy-auth':
      return {
        step: 'claude',
        status: 'warn',
        lines: [main('test.claude.proxyAuth', { host: bad.host, proxy: bad.proxyUrl ?? '' }), line('it', 'it.claudeBlocked', itVars)],
        data,
      };
    case 'dns':
    case 'connect':
    case 'proxy-denied':
      return {
        step: 'claude',
        status: 'warn',
        lines: [main('test.claude.unreachable', { host: bad.host, code: bad.code ?? '?' }), line('action', 'test.claude.unreachableAction'), line('it', 'it.claudeBlocked', itVars)],
        data,
      };
    default:
      return {
        step: 'claude',
        status: 'warn',
        lines: [main('test.claude.tls', { host: bad.host, code: bad.code ?? '?' }), line('it', 'it.claudeBlocked', itVars)],
        data,
      };
  }
}
