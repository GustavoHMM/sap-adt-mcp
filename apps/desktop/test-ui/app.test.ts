// Drives the real Electron window. Run with "npm run test:desktop" (builds first).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { deletePassword, getPassword } from '@abap-adt-mcp/core/credentials';
import { getProfile } from '@abap-adt-mcp/core/profiles';
import { makeTlsFixture, startAdtMock, tempHome, type AdtMock, type TlsFixture } from '../../../packages/core/test/helpers/fixtures.ts';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const electronExe = fileURLToPath(new URL('../../../node_modules/electron/dist/electron.exe', import.meta.url));
const shots = process.env.ABAP_ADT_MCP_SCREENSHOTS;
const windows = process.platform === 'win32';

let home: string;
let fixture: TlsFixture;
let mock: AdtMock;
let electronProcess: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page | undefined;

before(async () => {
  home = tempHome();
  fixture = makeTlsFixture();
  mock = await startAdtMock(fixture, 'TESTER', 'secret-1');
});

after(async () => {
  await browser?.close().catch(() => undefined);
  electronProcess?.kill();
  try {
    deletePassword('QAS400');
  } catch {
    // not created
  }
  await mock.close();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Starts the app and attaches over the Chromium DevTools protocol. Playwright's
 * electron.launch() relies on --inspect, which does not work with Electron 45 yet.
 */
async function launchApp(): Promise<Page> {
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  electronProcess = spawn(electronExe, [`--remote-debugging-port=${port}`, desktopDir], {
    env: { ...env, ABAP_ADT_MCP_HOME: home, ABAP_ADT_MCP_LANG: 'pt', ABAP_ADT_MCP_CLI_SOURCE: process.execPath },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  for (;;) {
    const found = browser.contexts().flatMap((c) => c.pages())[0];
    if (found) return found;
    if (Date.now() > deadline) throw new Error('no window');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('first run: paste the URL, save, trust the certificate, pass the test, finish', { skip: !windows, timeout: 180_000 }, async () => {
  page = await launchApp();
  await page.getByRole('heading', { name: 'Vamos conectar o Claude ao seu SAP' }).waitFor();
  await shot(page, '01-assistente');

  // A URL pasted from the browser, with path and client, is reduced to the origin.
  const url = page.getByLabel('Endereço do SAP');
  await url.fill(`${mock.origin}/sap/bc/adt/discovery?sap-client=400`);
  await url.blur();
  await page.getByText('Ajustamos o endereço').waitFor();
  assert.equal(await url.inputValue(), mock.origin);
  assert.equal(await page.getByLabel('Mandante').inputValue(), '400');
  await page.getByLabel('Usuário').fill('tester');
  await page.getByLabel('Senha').fill('secret-1');
  assert.equal(await page.getByLabel('Nome amigável').inputValue(), 'QAS 400');
  await page.getByText('Nome no Claude: abap-adt-QAS400').waitFor();
  await shot(page, '02-dados');
  await page.getByRole('button', { name: 'Salvar e testar' }).click();

  // The mock uses a self-signed certificate: the app offers to trust it for this profile only.
  const trust = page.getByRole('button', { name: 'Confiar neste certificado só no perfil QAS400' });
  await trust.waitFor({ timeout: 60_000 });
  await shot(page, '03-certificado');
  await trust.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confiar', exact: true }).click();

  await page.getByText('Tudo certo').waitFor({ timeout: 90_000 });
  assert.equal(await page.locator('li[data-status="ok"]').count(), 8);
  await shot(page, '04-teste-ok');

  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByText('Em breve').waitFor();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByText('"Mostre o código do programa SAPMV45A"').waitFor();
  await page.getByRole('button', { name: 'Concluir' }).click();
  await page.locator('[data-profile="QAS400"]').waitFor();
  await shot(page, '05-perfis');

  const stored = getProfile('QAS400')!;
  assert.equal(stored.url, mock.origin);
  assert.equal(stored.username, 'TESTER');
  assert.ok(stored.trustedCertificate && fs.existsSync(stored.trustedCertificate.file));
  assert.equal(getPassword('QAS400'), 'secret-1');
  assert.ok(!fs.readFileSync(path.join(home, 'profiles.json'), 'utf8').includes('secret-1'));
});

test('a wrong password is fixed from the test screen', { skip: !windows, timeout: 120_000 }, async () => {
  assert.ok(page, 'runs after the first-run test');
  const { setPassword } = await import('@abap-adt-mcp/core/credentials');
  setPassword('QAS400', 'errada');

  await page.locator('[data-profile="QAS400"]').getByRole('button', { name: 'Testar' }).click();
  const field = page.getByLabel('Nova senha');
  await field.waitFor({ timeout: 60_000 });
  await shot(page, '06-senha-errada');
  await field.fill('secret-1');
  await page.getByRole('button', { name: 'Salvar senha e testar de novo' }).click();
  await page.getByText('Tudo certo').waitFor({ timeout: 90_000 });
  assert.equal(getPassword('QAS400'), 'secret-1');

  await page.getByRole('tab', { name: 'Sobre' }).click();
  await page.getByTestId('upstream-version').getByText(/mcp-abap-adt 1\.2\.0 \(git 05bb510\)/).waitFor();
  await shot(page, '07-sobre');
});
