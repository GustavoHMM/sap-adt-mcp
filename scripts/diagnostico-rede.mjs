// Diagnóstico de rede: o Claude e o SAP são alcançáveis ao mesmo tempo? Por qual proxy/rota?
// Uso: node scripts/diagnostico-rede.mjs [rótulo]     (ex.: "com-vpn" ou "sem-vpn")
// Não usa senhas nem envia dados: só DNS, TCP, handshake TLS e um GET anônimo.
// O resultado vai para build/diag/rede-<data>-<rótulo>.json e um resumo aparece na tela.
import { X509Certificate } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProxy } from '../packages/core/src/proxy/resolve.ts';
import { getIeProxyConfig } from '../packages/core/src/proxy/winhttp.ts';
import { loadProfiles } from '../packages/core/src/profiles.ts';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const label = (process.argv[2] ?? 'sem-rotulo').replace(/[^\w-]/g, '_');
const TIMEOUT = 8000;
const caFiles = new Map();
const ca = [...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')];

const targets = [
  { name: 'Claude API', url: 'https://api.anthropic.com/' },
  { name: 'Claude (login e app)', url: 'https://claude.ai/' },
  { name: 'Anthropic', url: 'https://www.anthropic.com/' },
  ...loadProfiles().map((p) => ({ name: `SAP ${p.id}`, url: `${p.url}/sap/bc/adt/discovery`, sap: true })),
];

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'latin1', timeout: 15000, windowsHide: true });
  } catch (e) {
    return `erro: ${e.message}`;
  }
};
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what} timeout`), { code: 'TIMEOUT' })), ms))]);
const errCode = (e) => e?.code ?? e?.message ?? String(e);

function tunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${host}:${port}`, timeout: TIMEOUT });
    req.once('connect', (res, socket) => (res.statusCode === 200 ? resolve(socket) : (socket.destroy(), reject(Object.assign(new Error(`proxy ${res.statusCode}`), { code: `PROXY_${res.statusCode}`, authenticate: res.headers['proxy-authenticate'] })))));
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.once('error', reject);
    req.end();
  });
}

async function probe(target) {
  const u = new URL(target.url);
  const port = Number(u.port) || 443;
  const r = { name: target.name, host: u.hostname, port };
  try {
    const d = resolveProxy(u.origin);
    r.proxy = d.proxyUrl ?? 'DIRETO';
    r.proxySource = d.source;
    if (d.warning) r.proxyWarning = d.warning;
  } catch (e) {
    r.proxy = `erro: ${errCode(e)}`;
  }
  const proxy = r.proxy?.startsWith('http') ? new URL(r.proxy) : undefined;

  const t0 = Date.now();
  try {
    r.dns = (await timeout(dns.lookup(u.hostname, { all: true }), TIMEOUT, 'dns')).map((a) => a.address).slice(0, 4);
  } catch (e) {
    r.dns = `falhou (${errCode(e)})`;
  }
  r.dnsMs = Date.now() - t0;

  const t1 = Date.now();
  let socket;
  try {
    socket = proxy
      ? await tunnel(proxy, u.hostname, port)
      : await timeout(new Promise((res, rej) => { const s = net.connect({ host: u.hostname, port }); s.once('connect', () => res(s)); s.once('error', rej); }), TIMEOUT, 'tcp');
    r.tcp = proxy ? `ok via proxy ${proxy.host}` : 'ok';
  } catch (e) {
    r.tcp = `falhou (${errCode(e)}${e.authenticate ? `, proxy pede ${e.authenticate}` : ''})`;
  }
  r.tcpMs = Date.now() - t1;

  if (socket) {
    try {
      const s = await timeout(new Promise((res, rej) => {
        const c = tls.connect({ socket, servername: u.hostname, ca, rejectUnauthorized: false });
        c.once('secureConnect', () => res(c));
        c.once('error', rej);
      }), TIMEOUT, 'tls');
      const cert = s.getPeerCertificate(true);
      r.tls = s.authorized ? 'ok' : `não confiável (${s.authorizationError})`;
      r.tlsIssuer = [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(' / ');
      r.tlsSubject = cert.subject?.CN;
      if (!s.authorized) {
        // TLS inspection: keep the top of the chain (the inspecting CA) so IT can confirm it.
        let top = cert;
        const seen = new Set();
        while (top.issuerCertificate && top.issuerCertificate !== top && !seen.has(top.fingerprint256)) {
          seen.add(top.fingerprint256);
          top = top.issuerCertificate;
        }
        const x = new X509Certificate(top.raw);
        r.inspectingCa = { subject: x.subject.split('\n').join(', '), validFrom: x.validFrom, validTo: x.validTo, sha256: x.fingerprint256, sha1: x.fingerprint };
        caFiles.set(x.fingerprint256, { name: (top.subject?.CN ?? 'ca').replace(/[^\w-]/g, '_'), pem: x.toString() });
      }
      s.destroy();
    } catch (e) {
      r.tls = `falhou (${errCode(e)})`;
    }
  }

  // One anonymous GET, through the same proxy decision.
  const t2 = Date.now();
  try {
    const agent = new https.Agent({ ca, keepAlive: false, ...(proxy ? { proxyEnv: { HTTPS_PROXY: proxy.href, NO_PROXY: '' } } : {}) });
    const status = await timeout(new Promise((res, rej) => {
      const req = https.request(target.url, { method: 'GET', agent, headers: { 'user-agent': 'abap-adt-mcp-diagnostico' } }, (resp) => { resp.resume(); res(resp.statusCode); });
      req.once('error', rej);
      req.end();
    }), TIMEOUT, 'http');
    r.http = `HTTP ${status}`;
    agent.destroy();
  } catch (e) {
    r.http = `falhou (${errCode(e)})`;
  }
  r.httpMs = Date.now() - t2;
  return r;
}

const report = {
  label,
  time: new Date().toISOString(),
  ieProxy: (() => { try { return getIeProxyConfig(); } catch (e) { return `erro: ${errCode(e)}`; } })(),
  winhttpProxy: run('netsh', ['winhttp', 'show', 'proxy']).trim(),
  envProxy: Object.fromEntries(Object.entries(process.env).filter(([k]) => /proxy/i.test(k))),
  adapters: run('ipconfig', []).split(/\r?\n/).filter((l) => /adaptador|adapter|IPv4|Gateway|Sufixo DNS|DNS Suffix/i.test(l)).map((l) => l.trim()),
  defaultRoutes: run('route', ['print', '-4']).split(/\r?\n/).filter((l) => /^\s*0\.0\.0\.0\s+0\.0\.0\.0/.test(l)).map((l) => l.trim().replace(/\s+/g, ' ')),
  targets: [],
};
for (const target of targets) report.targets.push(await probe(target));

const dir = path.join(root, 'build', 'diag');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `rede-${report.time.replace(/[:.]/g, '-')}-${label}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
for (const [sha256, ca] of caFiles) {
  const caFile = path.join(dir, `${ca.name}-${sha256.replace(/:/g, '').slice(0, 12)}.cer`);
  fs.writeFileSync(caFile, ca.pem);
  console.log(`Certificado que inspeciona o tráfego salvo em ${caFile}`);
}

console.log(`Diagnóstico "${label}" salvo em ${file}\n`);
console.log('Rotas padrão:', report.defaultRoutes.join(' | ') || '(nenhuma)');
for (const t of report.targets) {
  console.log(`- ${t.name} (${t.host}:${t.port}): proxy=${t.proxy} dns=${Array.isArray(t.dns) ? t.dns.join(',') : t.dns} tcp=${t.tcp} tls=${t.tls ?? '-'}${t.tlsIssuer ? ` [emissor: ${t.tlsIssuer}]` : ''} http=${t.http}`);
}
