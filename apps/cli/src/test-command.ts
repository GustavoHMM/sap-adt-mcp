import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getPassword } from '@abap-adt-mcp/core/credentials';
import { t, type Lang } from '@abap-adt-mcp/core/messages';
import { runConnectionTest, type StepResult } from '@abap-adt-mcp/core/probe';
import { effectiveDisabledTools, type Profile } from '@abap-adt-mcp/core/profiles';
import { APP_VERSION } from '@abap-adt-mcp/core/version';
import { serveCommandFor } from './self.ts';

const ICON: Record<StepResult['status'], string> = { ok: '✔', warn: '⚠', fail: '✖', skip: '·' };

/** A harmless lookup that exists in every ABAP system. */
const PROBE_QUERY = 'CL_ABAP_TYPEDESCR';

export async function testConnection(profile: Profile, lang: Lang, json: boolean): Promise<number> {
  let password: string | null = null;
  try {
    password = getPassword(profile.id);
  } catch {
    password = null;
  }

  if (!json) process.stdout.write(t(lang, 'test.header', { profile: profile.id, url: profile.url, client: profile.client }) + '\n\n');

  const results = await runConnectionTest({
    profile,
    password,
    mcpCheck: () => mcpEndToEnd(profile),
    onStep: (r) => {
      if (json) process.stdout.write(JSON.stringify(render(r, lang)) + '\n');
      else printStep(r, lang);
    },
  });
  password = null;
  return results.some((r) => r.status === 'fail') ? 2 : 0;
}

function render(r: StepResult, lang: Lang) {
  return {
    step: r.step,
    status: r.status,
    lines: r.lines.map((l) => ({ kind: l.kind, key: l.key, text: t(lang, l.key, l.vars) })),
    data: r.data,
  };
}

function printStep(r: StepResult, lang: Lang): void {
  const title = t(lang, `test.step.${r.step}`);
  const [first, ...rest] = r.lines;
  process.stdout.write(`${ICON[r.status]} ${title}: ${first ? t(lang, first.key, first.vars) : ''}\n`);
  for (const line of rest) {
    const text = t(lang, line.key, line.vars);
    if (line.kind === 'basis') process.stdout.write(`    ${t(lang, 'test.basisText')}\n    "${text}"\n`);
    else process.stdout.write(`    ${line.kind === 'action' ? '→ ' : ''}${text}\n`);
  }
}

/** Starts "serve" exactly as Claude would and asks for tools and one search. */
async function mcpEndToEnd(profile: Profile): Promise<StepResult> {
  const { command, args } = serveCommandFor(profile.id);
  const transport = new StdioClientTransport({
    command,
    args,
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'abap-adt-mcp-test', version: APP_VERSION });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'SearchObject', arguments: { query: PROBE_QUERY, maxResults: 1 } });
    if (result.isError) {
      const first = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? '';
      return { step: 'mcp', status: 'fail', lines: [{ kind: 'main', key: 'test.mcp.fail', vars: { message: first.split('\n')[0] ?? '' } }] };
    }
    const hidden = effectiveDisabledTools(profile).size;
    return { step: 'mcp', status: 'ok', lines: [{ kind: 'main', key: 'test.mcp.ok', vars: { tools: tools.length, hidden } }] };
  } catch (e) {
    return { step: 'mcp', status: 'fail', lines: [{ kind: 'main', key: 'test.mcp.fail', vars: { message: (e as Error).message } }] };
  } finally {
    await client.close().catch(() => undefined);
  }
}
