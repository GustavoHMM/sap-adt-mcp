import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkClaudeAccess } from './claude-check.ts';
import { claudeStatus, type ServerCommand } from './claude/integration.ts';
import { redact } from './log.ts';
import { t, type Lang } from './messages.ts';
import { logsDir, stateDir } from './paths.ts';
import { runConnectionTest, type StepResult } from './probe.ts';
import { loadProfiles, type Profile } from './profiles.ts';
import { resolveProxy } from './proxy/resolve.ts';
import { getIeProxyConfig } from './proxy/winhttp.ts';
import { loadSettings } from './settings.ts';
import { upstreamInfo } from './upstream.ts';
import { APP_VERSION } from './version.ts';
import { createZip } from './zip.ts';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Everything that leaves the computer in a diagnostics package goes through
 * here: secrets in logs, SAP user names and the Windows user name (also inside
 * paths) are removed. Passwords are never read for diagnostics at all.
 */
export function makeSanitizer(sapUsers: string[], windowsUser = os.userInfo().username): (text: string) => string {
  const users = [...new Set(sapUsers.filter((u) => u && u.length >= 2))];
  return (text) => {
    let out = redact(text);
    // C:\Users\<name>\... in plain or JSON-escaped form, including 8.3 short names.
    out = out.replace(/([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))[^\\/"'\s]+/gi, '$1<usuario-windows>');
    out = out.replace(/(https?:\/\/)[^\s/@"']+:[^\s/@"']+@/gi, '$1<credenciais>@');
    for (const u of users) out = out.replace(new RegExp(`\\b${escapeRegExp(u)}\\b`, 'gi'), '<usuario-sap>');
    if (windowsUser && windowsUser.length >= 3) out = out.replace(new RegExp(`\\b${escapeRegExp(windowsUser)}\\b`, 'gi'), '<usuario-windows>');
    return out;
  };
}

function profileForDiagnostics(p: Profile) {
  const { username: _username, ...rest } = p;
  return { ...rest, username: '<usuario-sap>' };
}

function stepSummary(lang: Lang, r: StepResult): string {
  const first = r.lines[0];
  return `  [${r.status}] ${t(lang, `test.step.${r.step}`)}: ${first ? t(lang, first.key, first.vars) : ''}`;
}

export interface DiagnosticsOptions {
  lang: Lang;
  server: ServerCommand;
  /** DNS/TCP/TLS per profile without credentials, plus the Claude reachability check. */
  network?: boolean;
  /** Extra facts from the caller (e.g. the app's Electron version). */
  extra?: Record<string, unknown>;
}

export async function buildDiagnostics(options: DiagnosticsOptions): Promise<Buffer> {
  const { lang } = options;
  const profiles = loadProfiles();
  const clean = makeSanitizer(profiles.map((p) => p.username));
  const files: { name: string; data: string }[] = [];
  const json = (name: string, value: unknown) => files.push({ name, data: clean(JSON.stringify(value, null, 2)) });
  const summary: string[] = [];

  let up: unknown;
  try {
    up = upstreamInfo();
  } catch (e) {
    up = { error: (e as Error).message };
  }
  const environment = {
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    upstream: up,
    windows: { release: os.release(), version: os.version(), arch: process.arch, cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) },
    runtime: { node: process.version, openssl: process.versions.openssl },
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    languageSetting: loadSettings().language ?? 'windows',
    proxyEnvironmentVariables: Object.keys(process.env).filter((k) => /proxy/i.test(k)),
    ieProxy: (() => {
      try {
        return getIeProxyConfig();
      } catch (e) {
        return { error: (e as Error).message };
      }
    })(),
    ...options.extra,
  };
  json('ambiente.json', environment);
  summary.push(`ABAP ADT MCP ${APP_VERSION} | Windows ${os.release()} ${process.arch} | ${new Date().toISOString()}`);

  json('perfis.json', profiles.map(profileForDiagnostics));
  json('proxy.json', profiles.map((p) => {
    try {
      return { profile: p.id, ...resolveProxy(p.url, p.proxy) };
    } catch (e) {
      return { profile: p.id, error: (e as Error).message };
    }
  }));

  try {
    const status = claudeStatus(profiles, options.server);
    json('claude.json', status);
    const found = (yes: boolean) => (yes ? (lang === 'pt' ? 'instalado' : 'installed') : lang === 'pt' ? 'não encontrado' : 'not found');
    summary.push('', 'Claude:');
    summary.push(`  Desktop: ${found(status.desktop.installed)}${status.desktop.problem ? ` (${status.desktop.problem})` : ''} | Code: ${found(status.code.installed)}${status.code.problem ? ` (${status.code.problem})` : ''}`);
    for (const p of profiles) {
      const s = status.profiles[p.id];
      summary.push(`  ${p.id}: desktop=${s?.desktop.state} code=${s?.code.state}`);
    }
  } catch (e) {
    json('claude.json', { error: (e as Error).message });
  }

  if (options.network) {
    summary.push('', lang === 'pt' ? 'Rede (sem senha):' : 'Network (no password):');
    for (const p of profiles) {
      const results = await runConnectionTest({ profile: p, password: null, timeoutMs: 8000 });
      json(`rede/${p.id}.json`, results);
      summary.push(` ${p.id} (${p.url})`);
      for (const r of results.filter((x) => x.step !== 'claude' && x.status !== 'skip')) summary.push(stepSummary(lang, r));
    }
    if (process.env.ABAP_ADT_MCP_CLAUDE_CHECK !== 'off') {
      const claude = await checkClaudeAccess();
      json('rede/claude.json', claude);
      summary.push(stepSummary(lang, claude));
    }
  }

  for (const [dir, prefix] of [
    [logsDir(), 'logs'],
    [stateDir(), 'estado'],
  ] as const) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile() || fs.statSync(full).size > 5 * 1024 * 1024) continue;
      files.push({ name: `${prefix}/${name}`, data: clean(fs.readFileSync(full, 'utf8')) });
    }
  }

  const note =
    lang === 'pt'
      ? 'Este pacote não contém senhas, cookies, tokens CSRF, nomes de usuário do SAP nem o nome do usuário do Windows.'
      : 'This package contains no passwords, cookies, CSRF tokens, SAP user names or the Windows user name.';
  files.unshift({ name: 'resumo.txt', data: clean([...summary, '', note, ''].join('\r\n')) });
  return createZip(files);
}

/** Default file name on the Desktop (or the home folder when there is no Desktop). */
export function defaultDiagnosticsPath(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const desktop = path.join(os.homedir(), 'Desktop');
  return path.join(fs.existsSync(desktop) ? desktop : os.homedir(), `abap-adt-mcp-diagnostico-${stamp}.zip`);
}
