import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeTlsFixture, startAdtMock, tempHome, type AdtMock, type TlsFixture } from './helpers/fixtures.ts';
import { buildDiagnostics, makeSanitizer } from '../src/diagnostics.ts';
import { logsDir, stateDir } from '../src/paths.ts';
import { saveProfile, type Profile } from '../src/profiles.ts';
import { readZip } from '../src/zip.ts';

const windowsUser = os.userInfo().username;
const basic = Buffer.from('TESTER:secret-1').toString('base64');

let home: string;
let fixture: TlsFixture;
let mock: AdtMock;
let profile: Profile;

before(async () => {
  home = tempHome();
  fixture = makeTlsFixture();
  mock = await startAdtMock(fixture, 'TESTER', 'secret-1');
  profile = {
    id: 'DIAG400',
    name: 'Diagnóstico',
    url: mock.origin,
    client: '400',
    username: 'TESTER',
    language: 'PT',
    environment: 'QAS',
    proxy: { mode: 'direct' },
    trustedCertificate: { file: fixture.certFile, fingerprint256: '', subject: 'CN=localhost', validTo: '' },
  };
  saveProfile(profile);
  // Logs and state as a careless caller could have left them.
  fs.mkdirSync(logsDir(), { recursive: true });
  fs.writeFileSync(
    path.join(logsDir(), 'app.log'),
    [
      `{"event":"request","headers":{"Authorization":"Basic ${basic}","x-csrf-token":"fixture-token","Cookie":"MYSAPSSO2=sso-cookie; SAP_SESSIONID_MCK_400=session-cookie"}}`,
      `{"event":"login","user":"TESTER","exe":"C:\\\\Users\\\\${windowsUser}\\\\AppData\\\\Local\\\\abap-adt-mcp\\\\runtime\\\\current\\\\abap-adt-mcp.exe"}`,
      `proxy https://TESTER:secret-1@proxy.example:8080 for C:\\Users\\${windowsUser}\\Desktop`,
      `env SAP_PASSWORD=secret-1 started by ${windowsUser}`,
      '',
    ].join('\n'),
  );
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 'serve-DIAG400.code.json'), JSON.stringify({ client: 'claude-code', user: 'tester', cwd: `C:\\Users\\${windowsUser}` }));
});

after(async () => {
  await mock.close();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const SECRETS = ['secret-1', basic, 'fixture-token', 'sso-cookie', 'session-cookie'];

function assertClean(text: string, where: string): void {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${where} contains ${secret}`);
  assert.ok(!/tester/i.test(text), `${where} contains the SAP user name`);
  assert.ok(!new RegExp(`\\b${windowsUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text), `${where} contains the Windows user name`);
}

test('the sanitizer removes secrets, SAP users and the Windows user, also inside paths', () => {
  const clean = makeSanitizer(['TESTER'], 'maria');
  assert.equal(clean('C:\\Users\\maria\\AppData'), 'C:\\Users\\<usuario-windows>\\AppData');
  assert.equal(clean('"C:\\\\Users\\\\MARIA~1\\\\x"'), '"C:\\\\Users\\\\<usuario-windows>\\\\x"');
  assert.equal(clean('C:/Users/maria/x'), 'C:/Users/<usuario-windows>/x');
  assert.equal(clean('https://joao:pw@proxy:8080'), 'https://<credenciais>@proxy:8080');
  assert.equal(clean('user Tester ok'), 'user <usuario-sap> ok');
  assert.equal(clean('started by maria.'), 'started by <usuario-windows>.');
  assert.equal(clean('x-csrf-token: abc'), 'x-csrf-token: [redacted]');
  // Short or empty names are ignored instead of blanking common words.
  assert.equal(makeSanitizer(['', 'A'], 'ab')('A ab'), 'A ab');
});

test('the package has the environment, profiles, network test and logs, and nothing sensitive', async () => {
  const zip = readZip(await buildDiagnostics({ lang: 'pt', server: { command: 'C:\\abap-adt-mcp.exe', args: [] }, network: true }));
  const names = [...zip.keys()];
  for (const name of ['resumo.txt', 'ambiente.json', 'perfis.json', 'proxy.json', 'claude.json', 'rede/DIAG400.json', 'logs/app.log', 'estado/serve-DIAG400.code.json']) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  for (const [name, data] of zip) assertClean(data.toString('utf8'), name);

  const summary = zip.get('resumo.txt')!.toString('utf8');
  assert.match(summary, /Rede \(sem senha\):/);
  assert.match(summary, /\[ok\] .*TLS/i);
  assert.match(summary, /não contém senhas/);

  const profiles = JSON.parse(zip.get('perfis.json')!.toString('utf8')) as Profile[];
  assert.equal(profiles[0]!.username, '<usuario-sap>');
  assert.equal(profiles[0]!.url, mock.origin);

  // Without the password the network test stops after TLS: no HTTP request reaches SAP.
  assert.equal(mock.requests.length, 0);

  const log = zip.get('logs/app.log')!.toString('utf8');
  assert.match(log, /Basic \[redacted\]/);
  assert.match(log, /\\\\Users\\\\<usuario-windows>\\\\AppData/);
});

test('without network the package is built offline', async () => {
  const before = mock.requests.length;
  const zip = readZip(await buildDiagnostics({ lang: 'en', server: { command: 'C:\\abap-adt-mcp.exe', args: [] } }));
  assert.equal(mock.requests.length, before);
  assert.ok(![...zip.keys()].some((n) => n.startsWith('rede/')));
  assert.match(zip.get('resumo.txt')!.toString('utf8'), /contains no passwords/);
});
