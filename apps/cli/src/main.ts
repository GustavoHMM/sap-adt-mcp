#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isSea } from 'node:sea';
import { detectLang, t } from '@abap-adt-mcp/core/messages';
import { runUpstreamInProcess, UPSTREAM_SUBCOMMAND, upstreamInfo } from '@abap-adt-mcp/core/upstream';
import { APP_VERSION } from '@abap-adt-mcp/core/version';
import { addProfile, deleteProfile, findProfileOrThrow, listProfiles, setProfilePassword, showProfile, UsageError } from './profile-command.ts';
import { serve } from './serve.ts';
import { testConnection } from './test-command.ts';

async function main(argv: string[]): Promise<number> {
  const lang = detectLang();
  const [command, ...rest] = argv;

  // The single executable re-launches itself in this mode to become the upstream server.
  if (command === UPSTREAM_SUBCOMMAND && isSea()) {
    await runUpstreamInProcess();
    return -1;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      profile: { type: 'string' },
      json: { type: 'boolean' },
      stdin: { type: 'boolean' },
      id: { type: 'string' },
      name: { type: 'string' },
      url: { type: 'string' },
      client: { type: 'string' },
      user: { type: 'string' },
      env: { type: 'string' },
      lang: { type: 'string' },
      'allow-http': { type: 'boolean' },
    },
  });
  const option = (name: string) => (typeof values[name] === 'string' ? (values[name] as string) : undefined);

  try {
    switch (command) {
      case 'serve': {
        const profile = option('profile');
        if (!profile) throw new UsageError(t(lang, 'cli.missingOption', { option: 'profile' }));
        return await serve(profile);
      }
      case 'test': {
        const id = option('profile');
        if (!id) throw new UsageError(t(lang, 'cli.missingOption', { option: 'profile' }));
        return await testConnection(findProfileOrThrow(id, lang), lang, values.json === true);
      }
      case 'profile': {
        const [sub, id] = positionals;
        if (sub === 'add') addProfile(values, lang);
        else if (sub === 'list') listProfiles(lang);
        else if (sub === 'show' && id) showProfile(id, lang);
        else if (sub === 'remove' && id) deleteProfile(id, lang);
        else if (sub === 'set-password' && id) await setProfilePassword(id, values.stdin === true, lang);
        else throw new UsageError(t(lang, 'cli.usage'));
        return 0;
      }
      case 'version': {
        const up = upstreamInfo();
        process.stdout.write(
          t(lang, 'cli.version', {
            version: APP_VERSION,
            upstream: up.name,
            upstreamVersion: up.version,
            commit: up.commit?.slice(0, 7) ?? '?',
            node: process.version,
            arch: process.arch,
          }) + '\n',
        );
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
        process.stdout.write(t(lang, 'cli.usage') + '\n');
        return 0;
      default:
        throw new UsageError(`${t(lang, 'cli.unknownCommand', { command })}\n\n${t(lang, 'cli.usage')}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(e.message + '\n');
      return 64;
    }
    throw e;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // -1: keep running (the in-process upstream owns the event loop).
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`);
    process.exitCode = 1;
  },
);
