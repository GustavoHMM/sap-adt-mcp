import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { makeTlsFixture, startAdtMock, tempHome, type AdtMock, type TlsFixture } from './helpers/fixtures.ts';
import { AdtQueryClient, AdtQueryError, exceptionMessage, parseTableData, type QueryResult } from '../src/adt-query.ts';
import { checkSelect, createQueryTools, formatResult, tableQuery } from '../src/query-tools.ts';
import { effectiveDisabledTools, type Profile } from '../src/profiles.ts';

let fixture: TlsFixture;
let mock: AdtMock;
let profile: Profile;

before(async () => {
  tempHome();
  fixture = makeTlsFixture();
  mock = await startAdtMock(fixture, 'TESTER', 'secret-1');
  profile = {
    id: 'QRY400',
    name: 'Query',
    url: mock.origin,
    client: '400',
    username: 'TESTER',
    language: 'PT',
    environment: 'QAS',
    proxy: { mode: 'direct' },
    trustedCertificate: { file: fixture.certFile, fingerprint256: '', subject: 'CN=localhost', validTo: '' },
  };
});

after(async () => {
  await mock.close();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

const XML = `<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">
<dataPreview:totalRows>1071118</dataPreview:totalRows>
<dataPreview:columns><dataPreview:metadata dataPreview:name="MATNR" dataPreview:description="Nº do material" dataPreview:type="C"/>
<dataPreview:dataSet><dataPreview:data>2253964</dataPreview:data><dataPreview:data>A&amp;B &lt;x&gt; &#233;</dataPreview:data></dataPreview:dataSet></dataPreview:columns>
<dataPreview:columns><dataPreview:metadata dataPreview:name="ERSDA" dataPreview:description="Criado em"/>
<dataPreview:dataSet><dataPreview:data>20110115</dataPreview:data><dataPreview:data/></dataPreview:dataSet></dataPreview:columns>
</dataPreview:tableData>`;

test('the column-wise data preview answer becomes rows, with entities decoded', () => {
  const r = parseTableData(XML);
  assert.deepEqual(r.columns, [
    { name: 'MATNR', description: 'Nº do material' },
    { name: 'ERSDA', description: 'Criado em' },
  ]);
  assert.deepEqual(r.rows, [
    ['2253964', '20110115'],
    ['A&B <x> é', ''],
  ]);
  assert.equal(r.totalRows, 1071118);
  assert.deepEqual(parseTableData('<tableData><totalRows>0</totalRows></tableData>'), { columns: [], rows: [], totalRows: 0 });
});

test('ADT exception documents give their (localized) message', () => {
  const xml = '<exc:exception xmlns:exc="x"><message lang="EN">Unknown</message><localizedMessage lang="PT">Coluna &quot;X&quot; desconhecida</localizedMessage></exc:exception>';
  assert.equal(exceptionMessage(xml), 'Coluna "X" desconhecida');
  assert.equal(exceptionMessage('<exc:exception><message>Only EN</message></exc:exception>'), 'Only EN');
  assert.equal(exceptionMessage('<html>dump</html>'), undefined);
});

test('GetTableContents builds one SELECT from columns, where and order_by', () => {
  assert.equal(tableQuery({ table_name: 'mara' }), 'SELECT * FROM MARA');
  assert.equal(
    tableQuery({ table_name: 'MARA', columns: ['matnr', ' ERSDA '], where: "ERSDA >= '20240101'", order_by: 'ERSDA DESCENDING' }),
    "SELECT MATNR, ERSDA FROM MARA WHERE ERSDA >= '20240101' ORDER BY ERSDA DESCENDING",
  );
  assert.equal(tableQuery({ table_name: '/ABC/TAB', columns: ['MARA~MATNR'] }), 'SELECT MARA~MATNR FROM /ABC/TAB');
  for (const bad of [{ table_name: 'MARA WHERE 1=1' }, { table_name: '' }, { table_name: 'MARA', columns: [] }, { table_name: 'MARA', columns: ['A B'] }, { table_name: 'MARA', where: "1 = 1; DELETE FROM MARA" }]) {
    assert.throws(() => tableQuery(bad), Error, JSON.stringify(bad));
  }
});

test('RunSqlQuery accepts exactly one SELECT', () => {
  assert.equal(checkSelect('  select matnr from mara.  '), 'select matnr from mara');
  assert.equal(checkSelect('WITH +t AS ( SELECT matnr FROM mara ) SELECT * FROM +t'), 'WITH +t AS ( SELECT matnr FROM mara ) SELECT * FROM +t');
  for (const bad of ['DELETE FROM mara', 'UPDATE mara SET x = 1', '', 'SELECT 1 FROM mara; DELETE FROM mara']) assert.throws(() => checkSelect(bad), Error, bad);
});

const sample: QueryResult = {
  columns: [
    { name: 'MATNR', description: 'Material' },
    { name: 'ERSDA', description: 'Criado em' },
  ],
  rows: [
    ['1', '20110115'],
    ['2', 'tab\there\nand line'],
    ['3', '20260101   '],
  ],
  totalRows: 1071118,
};

test('the answer is a compact table with totals and column descriptions', () => {
  const text = formatResult(sample, 3, 'pt');
  assert.deepEqual(text.split('\n'), [
    '3 linha(s) de 1.071.118 que atendem à consulta.',
    'Limitado por max_rows=3. Para escolher quais linhas vêm, ordene (order_by ou ORDER BY) e filtre (where).',
    'Colunas: MATNR (Material), ERSDA (Criado em)',
    '',
    'MATNR\tERSDA',
    '1\t20110115',
    '2\ttab here and line',
    '3\t20260101',
  ]);
  assert.equal(formatResult({ columns: sample.columns, rows: [], totalRows: 0 }, 10, 'en'), '0 row(s) of 0 matching the query.');
});

test('a big answer is cut by whole rows inside the budget, and a too wide one explains itself', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [String(i), 'x'.repeat(50)]);
  const text = formatResult({ columns: sample.columns, rows }, 2000, 'pt');
  assert.ok(Buffer.byteLength(text) <= 40_000);
  assert.match(text, /Mostrando \d+ de 2\.000 linhas: a resposta passou de 40 KB/);
  const last = text.split('\n\n')[1]!.split('\n').at(-1)!;
  assert.match(last, /^\d+\tx{50}$/, 'no half rows');

  const wide = { columns: Array.from({ length: 900 }, (_, i) => ({ name: `FIELD${i}`, description: '' })), rows: [Array.from({ length: 900 }, () => 'v'.repeat(60))] };
  assert.match(formatResult(wide, 3, 'pt'), /A consulta tem 900 colunas e nem uma linha cabe em 40 KB/);
});

test('tool errors are plain language, and calls without a connection say why', async () => {
  const failing = (e: Error) => createQueryTools({ query: async () => Promise.reject(e) }, 'pt', 'QAS400', 'n/a');
  const call = async (e: Error, args: Record<string, unknown> = { sql: 'SELECT * FROM mara' }) => (await failing(e)[1]!.call(args));

  const sql = await call(new AdtQueryError('sql', 'Nome de coluna "NOPE" desconhecido', 400));
  assert.equal(sql.isError, true);
  assert.match(sql.text, /^Error: O SAP recusou a consulta: Nome de coluna "NOPE" desconhecido Confira/);
  assert.match((await call(new AdtQueryError('auth', 'HTTP 401', 401))).text, /recusou o usuário ou a senha do perfil QAS400/);
  assert.match((await call(new AdtQueryError('forbidden', 'Sem autorização para MARA', 403))).text, /negou a leitura .* \(Sem autorização para MARA\)/);
  assert.match((await call(new AdtQueryError('connection', 'ENOTFOUND'))).text, /VPN ou a rede/);
  assert.match((await call(new AdtQueryError('sql', 'x'), { sql: 'DELETE FROM mara' })).text, /único SELECT/);
  assert.match((await call(new AdtQueryError('sql', 'x'), { sql: 'SELECT 1 FROM t', max_rows: 0 })).text, /max_rows deve ser/);

  const off = createQueryTools(null, 'pt', 'QAS400', 'Não há senha salva para o perfil QAS400.');
  const r = await off[0]!.call({ table_name: 'MARA' });
  assert.deepEqual(r, { text: 'Error: Não há senha salva para o perfil QAS400.', isError: true });
});

test('the client fetches the CSRF token with a session, renews it once, and reports SAP errors', async () => {
  const client = new AdtQueryClient({ profile, password: 'secret-1', proxyUrl: null });
  try {
    const r = await client.query('SELECT matnr, ersda FROM mara ORDER BY ersda DESCENDING', 2);
    assert.deepEqual(r.columns.map((c) => c.name), ['MATNR', 'ERSDA', 'ERNAM', 'MAKTX']);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], ['2253964', '20110115', 'INTERFACE', 'Parafuso & porca']);
    assert.equal(r.rows[1]![3], '');
    assert.equal(r.totalRows, 5);
    assert.equal(mock.queries.at(-1), 'SELECT matnr, ersda FROM mara ORDER BY ersda DESCENDING');

    mock.expireToken = true;
    const before = mock.requests.filter((q) => q.path === '/sap/bc/adt/discovery').length;
    assert.equal((await client.query('SELECT * FROM mara', 1)).rows.length, 1);
    assert.equal(mock.requests.filter((q) => q.path === '/sap/bc/adt/discovery').length, before + 1, 'one new token');

    await assert.rejects(client.query('SELECT nope FROM mara', 1), (e: AdtQueryError) => e.kind === 'sql' && e.message === 'Nome de coluna "NOPE" desconhecido');
    const last = mock.requests.at(-1)!;
    assert.equal(last.client, '400');
    assert.equal(last.language, 'PT');
  } finally {
    client.close();
  }
  const wrong = new AdtQueryClient({ profile, password: 'wrong', proxyUrl: null });
  await assert.rejects(wrong.query('SELECT * FROM mara', 1), (e: AdtQueryError) => e.kind === 'auth');
  wrong.close();
});

test('business-data tools stay off outside DEV, also for choices made before RunSqlQuery existed', () => {
  const base: Profile = { id: 'P', name: 'P', url: 'https://sap', client: '400', username: 'U', environment: 'QAS' };
  assert.deepEqual([...effectiveDisabledTools(base)], ['GetTableContents', 'RunSqlQuery']);
  assert.deepEqual([...effectiveDisabledTools({ ...base, environment: 'DEV' })], []);
  // Enabled GetTableContents in 0.1.0: the new SQL tool must not come on by itself.
  assert.deepEqual([...effectiveDisabledTools({ ...base, disabledTools: [] })], ['RunSqlQuery']);
  // A choice made in this version covers every tool it showed.
  assert.deepEqual([...effectiveDisabledTools({ ...base, disabledTools: [], knownTools: ['GetTableContents', 'RunSqlQuery'] })], []);
  assert.deepEqual([...effectiveDisabledTools({ ...base, environment: 'DEV', disabledTools: ['GetProgram'] })], ['GetProgram']);
});
