import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { uniqueId } from './helpers/fixtures.ts';
import { credentialTarget, deletePassword, getPassword, setPassword } from '../src/credentials.ts';

const id = uniqueId('test');
after(() => {
  try {
    deletePassword(id);
  } catch {
    // already gone
  }
});

test('passwords round-trip through Windows Credential Manager, also from another process', { skip: process.platform !== 'win32' }, () => {
  assert.equal(getPassword(id), null);
  setPassword(id, 'çenha-de-teste-ÄÖÜ-🔑');
  assert.equal(getPassword(id), 'çenha-de-teste-ÄÖÜ-🔑');

  // "serve" always reads in a new process; this is what broke with Entry.withTarget().
  const script = `import { getPassword } from ${JSON.stringify(new URL('../src/credentials.ts', import.meta.url).href)}; process.stdout.write(getPassword(${JSON.stringify(id)}) ?? '<null>');`;
  const other = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(other.stdout, 'çenha-de-teste-ÄÖÜ-🔑');

  setPassword(id, 'trocada');
  assert.equal(getPassword(id), 'trocada');
  assert.equal(deletePassword(id), true);
  assert.equal(getPassword(id), null);
  assert.equal(credentialTarget(id), `${id}.abap-adt-mcp`);
});
