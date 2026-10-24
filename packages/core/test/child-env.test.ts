import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChildEnv } from '../src/child-env.ts';

const sap = { url: 'https://sap:44300', username: 'U', password: 'pw', client: '400', language: 'PT' };

test('only the allowlist is inherited; dangerous variables never reach the upstream', () => {
  const env = buildChildEnv(
    {
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      PATH: 'C:\\Users\\x\\evil;C:\\Windows\\System32',
      NODE_OPTIONS: '--require C:\\evil.js',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      TLS_REJECT_UNAUTHORIZED: '0',
      SSLKEYLOGFILE: 'C:\\keys.log',
      HTTPS_PROXY: 'http://attacker:8080',
      https_proxy: 'http://attacker:8080',
      SAP_CA_FILE: 'C:\\evil.pem',
      SAP_PASSWORD: 'leftover',
    },
    { sap },
  );
  for (const key of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSLKEYLOGFILE', 'HTTPS_PROXY', 'https_proxy', 'NODE_EXTRA_CA_CERTS']) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.PATH, 'C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.TEMP, 'C:\\Temp');
  assert.equal(env.TLS_REJECT_UNAUTHORIZED, '1');
  assert.equal(env.SAP_CA_FILE, '');
  assert.equal(env.NODE_USE_SYSTEM_CA, '1');
  assert.equal(env.SAP_PASSWORD, 'pw');
  assert.equal(env.SAP_LANGUAGE, 'PT');
});

test('profile certificate and proxy are passed the way the upstream understands them', () => {
  const env = buildChildEnv({ SystemRoot: 'C:\\Windows' }, { sap, extraCaFile: 'C:\\certs\\QAS400.pem', proxyUrl: 'http://proxy:3128' });
  assert.equal(env.NODE_EXTRA_CA_CERTS, 'C:\\certs\\QAS400.pem');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(env.NO_PROXY, '');
});
