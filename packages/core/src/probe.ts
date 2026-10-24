import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { commonName, summarizeCertificate, trustedCas, type CertificateSummary } from './certs.ts';
import type { MessageKey } from './messages.ts';
import type { Profile } from './profiles.ts';
import { resolveProxy, type ProxyDecision } from './proxy/resolve.ts';
import { APP_VERSION } from './version.ts';

export type StepId = 'url' | 'proxy' | 'dns' | 'tcp' | 'tls' | 'adt' | 'csrf' | 'mcp';
export type StepStatus = 'ok' | 'warn' | 'fail' | 'skip';
type Vars = Record<string, string | number>;

export interface StepLine {
  key: MessageKey;
  vars?: Vars;
  kind: 'main' | 'detail' | 'action' | 'basis';
}

export interface StepResult {
  step: StepId;
  status: StepStatus;
  lines: StepLine[];
  /** Machine-readable extras for the app (certificate to trust, redirect target, ...). */
  data?: Record<string, unknown>;
}

export interface ConnectionTestInput {
  profile: Profile;
  password: string | null;
  /** End-to-end MCP check, supplied by the CLI because it knows how to start itself. */
  mcpCheck?: () => Promise<StepResult>;
  onStep?: (result: StepResult) => void;
  timeoutMs?: number;
}

const STEPS: StepId[] = ['url', 'proxy', 'dns', 'tcp', 'tls', 'adt', 'csrf', 'mcp'];
const main = (key: MessageKey, vars?: Vars): StepLine => ({ key, vars, kind: 'main' });
const detail = (key: MessageKey, vars?: Vars): StepLine => ({ key, vars, kind: 'detail' });
const action = (key: MessageKey, vars?: Vars): StepLine => ({ key, vars, kind: 'action' });
const basis = (key: MessageKey, vars?: Vars): StepLine => ({ key, vars, kind: 'basis' });

/**
 * Runs the connection test step by step, with the same trust store and proxy
 * decision the upstream gets, and stops at the first failing step.
 */
export async function runConnectionTest(input: ConnectionTestInput): Promise<StepResult[]> {
  const { profile } = input;
  const timeout = input.timeoutMs ?? 10_000;
  const results: StepResult[] = [];
  const emit = (r: StepResult) => {
    results.push(r);
    input.onStep?.(r);
    return r;
  };
  const skipRest = () => {
    for (const step of STEPS.slice(results.length)) emit({ step, status: 'skip', lines: [main('test.skipped')] });
    return results;
  };

  const target = new URL(profile.url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);

  // 1. URL
  if (!secure && profile.environment === 'PRD') {
    emit({ step: 'url', status: 'fail', lines: [main('test.url.httpPrd')] });
    return skipRest();
  }
  emit({ step: 'url', status: secure ? 'ok' : 'warn', lines: [main(secure ? 'test.url.ok' : 'test.url.http', { origin: profile.url })] });

  // 2. Proxy
  let decision: ProxyDecision;
  try {
    decision = resolveProxy(profile.url, profile.proxy);
  } catch (e) {
    decision = { proxyUrl: null, source: 'system-none', warning: errorCode(e) };
  }
  const proxyLines = [decision.proxyUrl ? main('test.proxy.via', { proxy: decision.proxyUrl, source: decision.source }) : main('test.proxy.direct')];
  if (decision.warning) proxyLines.push(detail('test.proxy.warning', { warning: decision.warning }));
  emit({ step: 'proxy', status: decision.warning ? 'warn' : 'ok', lines: proxyLines, data: { ...decision } });
  const proxy = decision.proxyUrl ? new URL(decision.proxyUrl) : undefined;

  // 3. DNS (of the proxy when there is one: the proxy resolves the SAP name itself)
  const lookupHost = proxy ? proxy.hostname : host;
  if (net.isIP(lookupHost)) {
    emit({ step: 'dns', status: 'ok', lines: [main('test.dns.ok', { host: lookupHost, addresses: lookupHost })] });
  } else {
    try {
      const addresses = await withTimeout(dns.lookup(lookupHost, { all: true }), timeout, 'ETIMEOUT');
      emit({ step: 'dns', status: 'ok', lines: [main('test.dns.ok', { host: lookupHost, addresses: addresses.slice(0, 3).map((a) => a.address).join(', ') })] });
    } catch {
      emit({ step: 'dns', status: 'fail', lines: [main('test.dns.fail', { host: lookupHost }), action('test.dns.action')] });
      return skipRest();
    }
  }

  // 4. TCP, or the CONNECT tunnel when a proxy is used for HTTPS
  const started = Date.now();
  try {
    const socket = proxy && secure ? await openTunnel(proxy, host, port, timeout) : await connectTcp(proxy?.hostname ?? host, Number(proxy?.port) || (proxy ? 80 : port), timeout);
    socket.destroy();
    emit({ step: 'tcp', status: 'ok', lines: [main('test.tcp.ok', { host, port, ms: Date.now() - started })] });
  } catch (e) {
    emit({ step: 'tcp', status: 'fail', lines: tcpFailure(e, host, port, decision.proxyUrl) });
    return skipRest();
  }

  // 5. TLS
  if (secure) {
    const tlsResult = await checkTls(host, port, proxy, profile, timeout);
    emit(tlsResult);
    if (tlsResult.status === 'fail') return skipRest();
  } else {
    emit({ step: 'tls', status: 'skip', lines: [main('test.url.http', { origin: profile.url })] });
  }

  // 6 + 7. ADT discovery with Basic logon, fetching the CSRF token in the same request
  if (!input.password) {
    emit({ step: 'adt', status: 'fail', lines: [main('relay.noPassword', { profile: profile.id })] });
    return skipRest();
  }
  const adt = await checkAdt(profile, input.password, decision.proxyUrl, timeout);
  emit(adt.result);
  if (adt.result.status === 'fail') return skipRest();
  emit(
    adt.csrf
      ? { step: 'csrf', status: 'ok', lines: [main('test.csrf.ok')] }
      : { step: 'csrf', status: 'warn', lines: [main('test.csrf.missing')] },
  );

  // 8. MCP end to end
  if (input.mcpCheck) emit(await input.mcpCheck());
  else emit({ step: 'mcp', status: 'skip', lines: [main('test.skipped')] });
  return results;
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

function errorCode(e: unknown): string {
  return (e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e));
}

function connectTcp(host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeout, () => socket.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
    socket.once('connect', () => (socket.setTimeout(0), resolve(socket)));
    socket.once('error', reject);
  });
}

class ProxyStatusError extends Error {
  readonly status: number;
  readonly authenticate: string | undefined;
  constructor(status: number, authenticate: string | undefined) {
    super(`proxy answered ${status}`);
    this.status = status;
    this.authenticate = authenticate;
  }
}

class ProxyConnectError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Opens a CONNECT tunnel through an HTTP proxy, like axios does for the upstream. */
function openTunnel(proxy: URL, host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const req = (proxy.protocol === 'https:' ? https : http).request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, 'user-agent': `abap-adt-mcp/${APP_VERSION}` },
      timeout,
      agent: false,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new ProxyStatusError(res.statusCode ?? 0, res.headers['proxy-authenticate'] as string | undefined));
      }
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
    req.once('error', (e) => reject(new ProxyConnectError(errorCode(e))));
    req.end();
  });
}

function tcpFailure(e: unknown, host: string, port: number, proxyUrl: string | null): StepLine[] {
  if (e instanceof ProxyStatusError) {
    if (e.status === 407) {
      const scheme = (e.authenticate ?? '').split(/[\s,]/)[0] || '?';
      return [main('test.tcp.proxyAuth', { proxy: proxyUrl ?? '', scheme }), action('test.tcp.proxyAuthAction', { host })];
    }
    return [main('test.tcp.proxyDenied', { proxy: proxyUrl ?? '', host, status: e.status })];
  }
  if (e instanceof ProxyConnectError || (proxyUrl && !(e instanceof ProxyStatusError))) {
    return [main('test.tcp.proxyFail', { proxy: proxyUrl ?? '', code: errorCode(e) }), action('test.tcp.action')];
  }
  return [main('test.tcp.fail', { host, port, code: errorCode(e) }), action('test.tcp.action')];
}

const UNTRUSTED = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);
const WEAK = new Set(['EE_KEY_TOO_SMALL', 'CA_KEY_TOO_SMALL', 'CA_MD_TOO_WEAK']);

function tlsHandshake(
  host: string,
  port: number,
  proxy: URL | undefined,
  options: tls.ConnectionOptions,
  timeout: number,
): Promise<tls.TLSSocket> {
  return (async () => {
    const socket = proxy ? await openTunnel(proxy, host, port, timeout) : undefined;
    return new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ host, port, socket, servername: net.isIP(host) ? undefined : host, ...options });
      s.setTimeout(timeout, () => s.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
      s.once('secureConnect', () => resolve(s));
      s.once('error', reject);
    });
  })();
}

/** Picks the certificate to offer for trust: the self-signed root if the server sent it, else the top of the chain. */
function certificateToTrust(peer: tls.DetailedPeerCertificate): CertificateSummary {
  let current = peer;
  const seen = new Set<string>();
  while (current.issuerCertificate && current.issuerCertificate !== current && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    current = current.issuerCertificate;
  }
  return summarizeCertificate(current.raw);
}

async function checkTls(host: string, port: number, proxy: URL | undefined, profile: Profile, timeout: number): Promise<StepResult> {
  const ca = trustedCas(profile);
  try {
    const s = await tlsHandshake(host, port, proxy, { ca, rejectUnauthorized: true }, timeout);
    const leaf = summarizeCertificate(s.getPeerCertificate(false).raw);
    s.destroy();
    return { step: 'tls', status: 'ok', lines: [main('test.tls.ok', { issuer: commonName(leaf.issuer), validTo: leaf.validTo })] };
  } catch (e) {
    const code = errorCode(e);
    const message = e instanceof Error ? e.message : '';
    if (WEAK.has(code) || /key too small|md too weak/i.test(message)) {
      return { step: 'tls', status: 'fail', lines: [main('test.tls.weak', { code }), basis('basis.weak', { host })] };
    }
    if (code === 'ERR_SSL_UNSUPPORTED_PROTOCOL' || /unsupported protocol|wrong version number|protocol version|no protocols available/i.test(message)) {
      return { step: 'tls', status: 'fail', lines: [main('test.tls.protocol', { code }), basis('basis.protocol', { host })] };
    }
    // Read the certificate for display only: no data is sent over this connection.
    let peer: tls.DetailedPeerCertificate | undefined;
    try {
      const s = await tlsHandshake(host, port, proxy, { rejectUnauthorized: false }, timeout);
      peer = s.getPeerCertificate(true);
      s.destroy();
    } catch {
      return { step: 'tls', status: 'fail', lines: [main('test.tls.other', { code })] };
    }
    const leaf = summarizeCertificate(peer.raw);
    const shown = { subject: leaf.subject, issuer: leaf.issuer, validFrom: leaf.validFrom, validTo: leaf.validTo, fingerprint: leaf.fingerprint256 };
    if (code === 'CERT_HAS_EXPIRED') {
      return { step: 'tls', status: 'fail', lines: [main('test.tls.expired', { validTo: leaf.validTo }), detail('test.tls.details', shown)] };
    }
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      const names = (leaf.subjectAltName ?? '').split(/,\s*/).map((n) => n.replace(/^(DNS|IP Address):/, '')).filter(Boolean);
      return {
        step: 'tls',
        status: 'fail',
        lines: [main('test.tls.hostname', { host, names: names.join(', ') || commonName(leaf.subject) }), action('test.tls.hostnameAction')],
        data: { certificateNames: names },
      };
    }
    if (UNTRUSTED.has(code)) {
      return {
        step: 'tls',
        status: 'fail',
        lines: [main('test.tls.untrusted', { code }), detail('test.tls.details', shown), action('test.tls.untrustedAction')],
        data: { certificate: certificateToTrust(peer) },
      };
    }
    return { step: 'tls', status: 'fail', lines: [main('test.tls.other', { code }), detail('test.tls.details', shown)] };
  }
}

async function checkAdt(
  profile: Profile,
  password: string,
  proxyUrl: string | null,
  timeout: number,
): Promise<{ result: StepResult; csrf: boolean }> {
  const target = new URL('/sap/bc/adt/discovery', profile.url);
  target.searchParams.set('sap-client', profile.client);
  if (profile.language) target.searchParams.set('sap-language', profile.language.toUpperCase());
  const secure = target.protocol === 'https:';
  const proxyEnv = proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: '' } : undefined;
  const agent = secure
    ? new https.Agent({ ca: trustedCas(profile), keepAlive: false, ...(proxyEnv ? { proxyEnv } : {}) })
    : new http.Agent({ keepAlive: false, ...(proxyEnv ? { proxyEnv } : {}) });
  const auth = Buffer.from(`${profile.username}:${password}`).toString('base64');

  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = (secure ? https : http).request(target, {
        method: 'GET',
        agent,
        timeout,
        headers: {
          authorization: `Basic ${auth}`,
          'x-csrf-token': 'fetch',
          accept: 'application/atomsvc+xml',
          'user-agent': `abap-adt-mcp/${APP_VERSION}`,
        },
      });
      req.once('response', resolve);
      req.once('timeout', () => req.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
      req.once('error', reject);
      req.end();
    });
    res.resume();
    const status = res.statusCode ?? 0;
    const vars = { host: target.hostname, client: profile.client, user: profile.username, status };
    const token = res.headers['x-csrf-token'];
    const csrf = typeof token === 'string' && token.length > 0 && token.toLowerCase() !== 'required';
    if (status >= 200 && status < 300) return { result: { step: 'adt', status: 'ok', lines: [main('test.adt.ok')] }, csrf };
    if (status === 401) return fail([main('test.adt.401'), action('test.adt.401action')]);
    if (status === 403) return fail([main('test.adt.403'), basis('basis.403', vars)]);
    if (status === 404) return fail([main('test.adt.404'), basis('basis.404', vars)]);
    if (status >= 300 && status < 400) {
      const location = String(res.headers.location ?? '');
      let suggestion: string | undefined;
      try {
        suggestion = new URL(location, target).origin;
      } catch {
        suggestion = undefined;
      }
      const lines = [main('test.adt.redirect', { location })];
      if (suggestion && suggestion !== profile.url) lines.push(action('test.adt.redirectAction', { suggestion }));
      return { result: { step: 'adt', status: 'fail', lines, data: { redirectOrigin: suggestion } }, csrf: false };
    }
    if (status >= 500) return fail([main('test.adt.5xx', vars)]);
    return fail([main('test.adt.other', vars)]);
  } catch (e) {
    return fail([main('test.adt.network', { code: errorCode(e) })]);
  } finally {
    agent.destroy();
  }

  function fail(lines: StepLine[]) {
    return { result: { step: 'adt' as const, status: 'fail' as const, lines }, csrf: false };
  }
}
