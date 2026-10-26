import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { deletePassword, setPassword } from '@abap-adt-mcp/core/credentials';
import { saveProfile, type Profile } from '@abap-adt-mcp/core/profiles';
import { readServeRecord } from '@abap-adt-mcp/core/state';
import { readZip } from '@abap-adt-mcp/core/zip';
import { makeTlsFixture, startAdtMock, startConnectProxy, tempHome, uniqueId, type AdtMock, type TlsFixture } from '../../../packages/core/test/helpers/fixtures.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const windows = process.platform === 'win32';
/** Set ABAP_ADT_MCP_CLI_EXE to run these tests against a built abap-adt-mcp.exe instead of the sources. */
const EXE = process.env.ABAP_ADT_MCP_CLI_EXE;
const cli = (args: string[]) => (EXE ? { command: EXE, args } : { command: process.execPath, args: [MAIN, ...args] });

let home: string;
let fixture: TlsFixture;
let mock: AdtMock;
let profile: Profile;

before(async () => {
  home = tempHome();
  fixture = makeTlsFixture();
  mock = await startAdtMock(fixture, 'TESTER', 'secret-1');
  profile = {
    id: uniqueId('E2E'),
    name: 'E2E',
    url: mock.origin,
    client: '400',
    username: 'TESTER',
    language: 'PT',
    environment: 'QAS',
    proxy: { mode: 'direct' },
    trustedCertificate: { file: fixture.certFile, fingerprint256: '', subject: 'CN=localhost', validTo: '' },
  };
  saveProfile(profile);
  if (windows) setPassword(profile.id, 'secret-1');
});

after(async () => {
  if (windows) deletePassword(profile.id);
  await mock.close();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const childEnv = () => ({
  ...(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))),
  ABAP_ADT_MCP_HOME: home,
  ABAP_ADT_MCP_LANG: 'pt',
});

async function connect(mode: 'auto' | 'legacy' = 'auto', profileId = profile.id) {
  const transport = new StdioClientTransport({ ...cli(['serve', '--profile', profileId]), env: childEnv(), stderr: 'pipe' });
  const client = new Client({ name: 'e2e', version: '1' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

const text = (r: { content?: unknown }) => ((r.content as { text?: string }[])[0]?.text ?? '');

for (const mode of ['auto', 'legacy'] as const) {
  test(`serve (${mode} protocol): filtered tools, real calls and disabled tools`, { skip: !windows }, async () => {
    const client = await connect(mode);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      assert.equal(names.length, 15);
      assert.ok(!names.includes('GetTableContents'));

      const search = await client.callTool({ name: 'SearchObject', arguments: { query: 'CL_ABAP_TYPEDESCR', maxResults: 1 } });
      assert.equal(search.isError, false);
      assert.match(text(search), /CL_ABAP_TYPEDESCR/);

      const program = await client.callTool({ name: 'GetProgram', arguments: { program_name: 'ZFIXTURE' } });
      assert.match(text(program), /REPORT zfixture\.\nWRITE: \/ 'Olá'\./);

      await assert.rejects(
        client.callTool({ name: 'GetTableContents', arguments: { table_name: 'KNA1' } }),
        /GetTableContents está desativada no perfil/,
      );
      const last = mock.requests.at(-1)!;
      assert.equal(last.client, '400');
      assert.ok(mock.requests.every((r) => r.path !== '/sap/bc/adt/datapreview/freestyle'));
    } finally {
      await client.close();
    }
    const record = readServeRecord(profile.id);
    assert.equal(record?.clientName, 'e2e');
  });
}

test('a wrong password returns the upstream error plus guidance in Portuguese', { skip: !windows }, async () => {
  setPassword(profile.id, 'wrong');
  const client = await connect();
  try {
    const r = await client.callTool({ name: 'GetProgram', arguments: { program_name: 'ZFIXTURE' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /^Error: SAP request failed \(HTTP 401\)\n\nO SAP recusou o usuário ou a senha/);
  } finally {
    await client.close();
    setPassword(profile.id, 'secret-1');
  }
});

test('the upstream reaches SAP through the proxy with a CONNECT tunnel only', { skip: !windows }, async () => {
  const proxy = await startConnectProxy();
  const proxied = { ...profile, id: uniqueId('E2EPX'), proxy: { mode: 'manual' as const, url: proxy.url } };
  saveProfile(proxied);
  setPassword(proxied.id, 'secret-1');
  const client = await connect('auto', proxied.id);
  try {
    const r = await client.callTool({ name: 'GetProgram', arguments: { program_name: 'ZFIXTURE' } });
    assert.equal(r.isError, false);
    assert.ok(proxy.connects.includes(`localhost:${mock.port}`));
    assert.deepEqual(proxy.plainRequests, []);
  } finally {
    await client.close();
    deletePassword(proxied.id);
    await proxy.close();
  }
});

test('an unknown profile still starts, and every call explains what to do', { skip: !windows }, async () => {
  const client = await connect('auto', 'NAOEXISTE');
  try {
    // 16 upstream tools, GetTableContents replaced by the launcher's, plus RunSqlQuery.
    assert.equal((await client.listTools()).tools.length, 17);
    const reason = 'Error: O perfil NAOEXISTE não existe neste computador. Abra o app ABAP ADT MCP e reconecte o Claude ao perfil certo.';
    assert.equal(text(await client.callTool({ name: 'GetProgram', arguments: { program_name: 'Z' } })), reason);
    assert.equal(text(await client.callTool({ name: 'RunSqlQuery', arguments: { sql: 'SELECT * FROM t000' } })), reason);
  } finally {
    await client.close();
  }
});

test('the test command runs every step, including MCP end to end', { skip: !windows }, async () => {
  // Asynchronous on purpose: the mock SAP lives in this process and must keep answering.
  const run = await runCli(['test', '--profile', profile.id, '--json']);
  const steps = run.stdout.trim().split('\n').map((l) => JSON.parse(l) as { step: string; status: string; lines: { text: string }[] });
  assert.deepEqual(
    steps.map((s) => `${s.step}:${s.status}`),
    ['url:ok', 'proxy:ok', 'dns:ok', 'tcp:ok', 'tls:ok', 'adt:ok', 'csrf:ok', 'mcp:ok', 'claude:skip'],
  );
  assert.match(steps.find((s) => s.step === 'mcp')!.lines[0]!.text, /15 ferramentas disponíveis para o Claude \(desativadas neste perfil: 2\)/);
  assert.equal(run.code, 0);
  assert.ok(!run.stdout.includes('secret-1'));
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { command, args: fullArgs } = cli(args);
    const child = spawn(command, fullArgs, { env: childEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('serve logs never contain the password or the CSRF token', { skip: !windows }, () => {
  const logs = fs.readdirSync(path.join(home, 'logs')).map((f) => fs.readFileSync(path.join(home, 'logs', f), 'utf8')).join('\n');
  assert.ok(logs.length > 0);
  assert.ok(!logs.includes('secret-1'));
  assert.ok(!logs.includes('fixture-token'));
});

test('diagnostics writes a .zip with the real logs and without secrets or user names', { skip: !windows }, async () => {
  const file = path.join(home, 'saida', 'diagnostico.zip');
  const run = await runCli(['diagnostics', '--out', file, '--no-network']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /diagnostico\.zip/);
  const zip = readZip(fs.readFileSync(file));
  assert.ok([...zip.keys()].some((n) => n.startsWith('logs/')));
  const all = [...zip.values()].map((b) => b.toString('utf8')).join('\n');
  for (const secret of ['secret-1', 'fixture-token', Buffer.from('TESTER:secret-1').toString('base64')]) assert.ok(!all.includes(secret), secret);
  assert.ok(!/tester/i.test(all));
});

test('an exe shipped without its native modules says the installation is incomplete', { skip: !EXE }, async () => {
  // What a broken package looked like: exe and upstream, no node_modules next to them.
  // Outside the test home: a freshly copied exe can stay locked for a moment (antivirus scan).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abap-adt-mcp-incompleto-'));
  fs.copyFileSync(EXE!, path.join(dir, 'abap-adt-mcp.exe'));
  fs.cpSync(path.join(path.dirname(EXE!), 'upstream'), path.join(dir, 'upstream'), { recursive: true });
  const exe = path.join(dir, 'abap-adt-mcp.exe');
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(exe, args, { env: childEnv() });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });

  const version = JSON.parse((await run(['version', '--json'])).stdout) as { missingComponents: string[] };
  assert.deepEqual(version.missingComponents, ['@napi-rs/keyring', 'koffi']);

  const test = await run(['test', '--profile', profile.id, '--json']);
  assert.equal(test.code, 1);
  assert.equal(test.stdout, '', 'no step runs, so nothing claims "no password"');
  assert.match(test.stderr, /A instalação do ABAP ADT MCP está incompleta: faltam componentes internos \(@napi-rs\/keyring, koffi\)/);
  assert.ok(!/Cannot find module/.test(test.stderr));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

for (const mode of ['auto', 'legacy'] as const) {
  test(`serve (${mode} protocol): table contents and SQL queries are answered by the launcher`, { skip: !windows }, async () => {
    const id = uniqueId('QRY');
    saveProfile({ ...profile, id, disabledTools: [], knownTools: ['GetTableContents', 'RunSqlQuery'] });
    setPassword(id, 'secret-1');
    const client = await connect(mode, id);
    try {
      const { tools } = await client.listTools();
      const contents = tools.find((t) => t.name === 'GetTableContents');
      assert.ok(tools.some((t) => t.name === 'RunSqlQuery'));
      assert.ok((contents?.inputSchema.properties as Record<string, unknown>).order_by, 'the launcher schema, not the upstream one');

      const rows = await client.callTool({
        name: 'GetTableContents',
        arguments: { table_name: 'mara', columns: ['MATNR', 'ERSDA'], order_by: 'ERSDA DESCENDING', max_rows: 2 },
      });
      assert.equal(rows.isError, false);
      assert.equal(mock.queries.at(-1), 'SELECT MATNR, ERSDA FROM MARA ORDER BY ERSDA DESCENDING');
      assert.match(text(rows), /^2 linha\(s\) de 5 que atendem à consulta\./);
      assert.match(text(rows), /\nMATNR\tERSDA\tERNAM\tMAKTX\n2253964\t20110115\tINTERFACE\tParafuso & porca\n/);

      const bad = await client.callTool({ name: 'RunSqlQuery', arguments: { sql: 'SELECT nope FROM mara' } });
      assert.equal(bad.isError, true);
      assert.match(text(bad), /O SAP recusou a consulta: Nome de coluna "NOPE" desconhecido/);
    } finally {
      await client.close();
      deletePassword(id);
    }
  });
}
