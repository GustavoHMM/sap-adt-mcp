import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineSplitter, McpRelay, type ToolCallEvent } from '../src/relay.ts';

const relay = (extra: Partial<ConstructorParameters<typeof McpRelay>[0]> = {}) =>
  new McpRelay({ profileId: 'QAS400', lang: 'pt', disabledTools: new Set(['GetTableContents']), ...extra });

const tools = ['GetProgram', 'GetTableContents', 'SearchObject'].map((name) => ({ name, inputSchema: { type: 'object' } }));

test('tools/list hides disabled tools, in both protocol eras', () => {
  for (const meta of [undefined, { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }]) {
    const r = relay();
    const req = { jsonrpc: '2.0', id: 7, method: 'tools/list', params: meta ? { _meta: meta } : {} };
    assert.deepEqual(r.handleClientLine(JSON.stringify(req)), { toServer: [JSON.stringify(req)], toClient: [] });
    const out = JSON.parse(r.handleServerLine(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools, resultType: 'complete' } })));
    assert.deepEqual(out.result.tools.map((t: { name: string }) => t.name), ['GetProgram', 'SearchObject']);
    assert.equal(out.result.resultType, 'complete');
  }
});

test('calls to a disabled tool are answered locally and never reach the upstream', () => {
  const r = relay();
  const call = { jsonrpc: '2.0', id: 'a1', method: 'tools/call', params: { name: 'GetTableContents', arguments: { table_name: 'KNA1' } } };
  const out = r.handleClientLine(JSON.stringify(call));
  assert.deepEqual(out.toServer, []);
  const reply = JSON.parse(out.toClient[0]!);
  assert.equal(reply.id, 'a1');
  assert.equal(reply.error.code, -32602);
  assert.match(reply.error.message, /GetTableContents está desativada no perfil QAS400/);
});

test('upstream HTTP errors get plain-language guidance appended', () => {
  const cases: [string, RegExp][] = [
    ['Error: SAP request failed (HTTP 401)', /recusou o usuário ou a senha do perfil QAS400/],
    ['Error: SAP request failed (HTTP 403)', /não tem autorização/],
    ['Error: SAP request failed (HTTP 404)', /objeto não foi encontrado/],
    ['Error: SAP request failed (HTTP 302)', /redirecionamento \(HTTP 302\)/],
    ['Error: SAP request failed (HTTP 500)', /erro interno \(HTTP 500\)/],
    ['Error: SAP connection failed; verify SAP_URL, certificate trust and network access', /VPN ou a rede/],
    ['Error: Missing required environment variables: SAP_URL, SAP_USERNAME, SAP_PASSWORD, SAP_CLIENT', /Não há senha salva/],
  ];
  for (const [text, expected] of cases) {
    const events: ToolCallEvent[] = [];
    const r = relay({ onToolCall: (e) => events.push(e) });
    r.handleClientLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'GetProgram', arguments: {} } }));
    const out = JSON.parse(r.handleServerLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text }] } })));
    assert.ok(out.result.content[0].text.startsWith(text), 'keeps the upstream text first');
    assert.match(out.result.content[0].text, expected);
    assert.equal(events[0]?.isError, true);
  }
});

test('successful results and unrelated messages pass through byte for byte', () => {
  const r = relay();
  r.handleClientLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'GetProgram' } }));
  const ok = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'REPORT z.' }] } });
  assert.equal(r.handleServerLine(ok), ok);
  const note = '{"jsonrpc":"2.0","method":"notifications/message","params":{}}';
  assert.equal(r.handleServerLine(note), note);
  assert.equal(r.handleServerLine('not json'), 'not json');
});

test('a blocked profile replaces every tool error with the reason', () => {
  const r = relay({ blockedReason: 'O perfil QAS400 não existe neste computador.' });
  r.handleClientLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'GetProgram' } }));
  const out = JSON.parse(
    r.handleServerLine(JSON.stringify({ jsonrpc: '2.0', id: 9, result: { isError: true, content: [{ type: 'text', text: 'Error: Missing required environment variables' }] } })),
  );
  assert.equal(out.result.content[0].text, 'Error: O perfil QAS400 não existe neste computador.');
});

test('client info is reported once, from initialize or modern _meta', () => {
  const seen: unknown[] = [];
  const r = relay({ onClientInfo: (i) => seen.push(i) });
  r.handleClientLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1' } } } }));
  r.handleClientLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { clientInfo: { name: 'other', version: '1' } } }));
  assert.deepEqual(seen, [{ name: 'claude-code', version: '2.1' }]);
});

test('lines are split across chunks and CRLF is tolerated', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":1}\r\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(':2}\n\n'), ['{"b":2}']);
  assert.deepEqual(s.push('{"c":3}'), []);
  assert.deepEqual(s.flush(), ['{"c":3}']);
});
