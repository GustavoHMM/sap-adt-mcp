import { spawn } from 'node:child_process';
import { extraCaFile } from '@abap-adt-mcp/core/certs';
import { buildChildEnv } from '@abap-adt-mcp/core/child-env';
import { getPassword } from '@abap-adt-mcp/core/credentials';
import { createLogger } from '@abap-adt-mcp/core/log';
import { detectLang, t } from '@abap-adt-mcp/core/messages';
import { missingComponents } from '@abap-adt-mcp/core/native';
import { effectiveDisabledTools, getProfile, validateProfile, type Profile } from '@abap-adt-mcp/core/profiles';
import { resolveProxy } from '@abap-adt-mcp/core/proxy/resolve';
import { LineSplitter, McpRelay } from '@abap-adt-mcp/core/relay';
import { writeServeRecord } from '@abap-adt-mcp/core/state';
import { verifyUpstream } from '@abap-adt-mcp/core/integrity';
import { hasStrayDotEnv, upstreamCommand, upstreamDir } from '@abap-adt-mcp/core/upstream';
import { APP_VERSION } from '@abap-adt-mcp/core/version';

/**
 * "serve": the command Claude runs. Reads the profile and the password, decides
 * proxy and trust, starts the unmodified upstream with that configuration in its
 * environment only, and relays stdio through the tool filter.
 */
export async function serve(profileId: string): Promise<number> {
  const lang = detectLang();
  const log = createLogger(`serve-${profileId.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  const started = Date.now();

  let profile: Profile | undefined;
  let blockedReason: string | undefined;
  let password = '';
  let proxyUrl: string | null = null;

  try {
    profile = getProfile(profileId);
  } catch (e) {
    blockedReason = t(lang, 'blocked.profileInvalid', { profile: profileId, problems: (e as Error).message });
  }
  if (!profile && !blockedReason) blockedReason = t(lang, 'blocked.profileMissing', { profile: profileId });

  if (profile) {
    const problems = validateProfile(profile);
    if (problems.includes('http-in-prd')) blockedReason = t(lang, 'blocked.httpPrd', { profile: profile.id });
    else if (problems.includes('http-not-accepted')) blockedReason = t(lang, 'blocked.httpNotAccepted', { profile: profile.id });
    else if (problems.length) blockedReason = t(lang, 'blocked.profileInvalid', { profile: profile.id, problems: problems.join(', ') });
  }
  const missing = missingComponents();
  if (missing.length) {
    blockedReason = t(lang, 'blocked.incomplete', { components: missing.join(', ') });
    log.error('components', { missing });
  }
  if (hasStrayDotEnv()) blockedReason = t(lang, 'blocked.dotenv');
  const integrity = verifyUpstream(upstreamDir());
  if (!integrity.ok) {
    blockedReason = t(lang, 'blocked.tampered');
    log.error('integrity', { problem: integrity.problem });
  }

  if (profile && !blockedReason) {
    try {
      password = getPassword(profile.id) ?? '';
    } catch (e) {
      blockedReason = t(lang, 'blocked.credentialStore', { detail: (e as Error).message });
    }
    try {
      const decision = resolveProxy(profile.url, profile.proxy);
      proxyUrl = decision.proxyUrl;
      log.info('proxy', { source: decision.source, viaProxy: Boolean(proxyUrl), warning: decision.warning });
    } catch (e) {
      log.warn('proxy-failed', { error: (e as Error).message });
    }
  }

  const disabledTools = profile ? effectiveDisabledTools(profile) : new Set<string>();
  const usable = profile && !blockedReason;
  const env = buildChildEnv(process.env, {
    sap: usable
      ? { url: profile!.url, username: profile!.username, password, client: profile!.client, language: profile!.language }
      : { url: '', username: '', password: '', client: '' },
    extraCaFile: usable ? extraCaFile(profile!) : undefined,
    proxyUrl: usable ? proxyUrl : null,
  });
  password = '';

  log.info('start', {
    version: APP_VERSION,
    blocked: Boolean(blockedReason),
    disabledTools: [...disabledTools],
    hasPassword: Boolean(env.SAP_PASSWORD),
  });

  const { command, args } = upstreamCommand();
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  const relay = new McpRelay({
    profileId: profile?.id ?? profileId,
    lang,
    disabledTools,
    blockedReason,
    onClientInfo: (info) => {
      log.info('client', { name: info.name, version: info.version });
      if (profile) {
        writeServeRecord({
          profileId: profile.id,
          startedAt: new Date(started).toISOString(),
          appVersion: APP_VERSION,
          clientName: info.name,
          clientVersion: info.version,
          executable: process.execPath,
        });
      }
    },
    onToolCall: (e) => log.info('tool', { ...e }),
  });

  const fromClient = new LineSplitter();
  const fromServer = new LineSplitter();
  const writeClient = (line: string) => process.stdout.write(line + '\n');
  const writeServer = (line: string) => {
    if (child.stdin.writable) child.stdin.write(line + '\n');
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of fromClient.push(chunk)) {
      const { toServer, toClient } = relay.handleClientLine(line);
      toServer.forEach(writeServer);
      toClient.forEach(writeClient);
    }
  });
  process.stdin.on('end', () => {
    for (const line of fromClient.flush()) relay.handleClientLine(line).toServer.forEach(writeServer);
    child.stdin.end();
    // Claude on Windows kills the process tree 300 ms after closing stdin; finish first.
    setTimeout(() => child.kill(), 200).unref();
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of fromServer.push(chunk)) writeClient(relay.handleServerLine(line));
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(chunk);
    log.warn('upstream-stderr', { text: chunk.slice(0, 500) });
  });

  const stop = () => child.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return new Promise<number>((resolve) => {
    child.once('error', (e) => {
      log.error('spawn-failed', { error: e.message });
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      for (const line of fromServer.flush()) writeClient(relay.handleServerLine(line));
      log.info('exit', { code, signal, ms: Date.now() - started });
      resolve(code ?? 0);
    });
  });
}
