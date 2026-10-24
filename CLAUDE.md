# CLAUDE.md — abap-adt-mcp

App para Windows que conecta o Claude (Desktop e Code) ao SAP via ADT, empacotando o servidor MCP [mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt) (MIT, mario-andreschak) sem modificá-lo.

## Como trabalhar neste repositório

- Responda e documente em **português**. Os comentários de código ficam em inglês.
- Trabalhe em fases curtas e **mostre o plano antes de escrever código**. Comandos de teste para o usuário vão em PowerShell.
- **Nunca altere `vendor/mcp-abap-adt`.** O que faltar no upstream é feito no launcher (`packages/core`, `apps/cli`).
- Na dúvida sobre comportamento do SAP ou do ADT, pergunte ao usuário em vez de supor.
- Commits pequenos, por fase, com a linha `Co-Authored-By` do Claude.
- Nunca use scripts `.ps1` no produto. A política padrão do Windows bloqueia (aconteceu com o `npx.ps1`). Em desenvolvimento, use `npm.cmd` e `npx.cmd`.

## Decisões (ver docs/fase-0-plano.md para o raciocínio)

| Tema | Decisão |
|---|---|
| Upstream | Submódulo git fixo no commit `05bb510` (1.2.0). **Não usar o pacote do npm**: o `mcp-abap-adt@1.2.0` do npm é anterior ao SDK 2 e ao endurecimento de TLS. O app mostra versão + commit. |
| Executáveis | `abap-adt-mcp.exe` (console, Node 24 LTS oficial em SEA) para `serve`/`test`/`profile`; o Claude chama só esse. Interface futura em Electron. O processo principal do Electron **não tem stdin no Windows**, por isso não pode ser o servidor MCP. |
| Processo do upstream | Filho do `serve` (o mesmo exe com `__upstream`; em dev, `node vendor/.../dist/index.js`). A configuração vai só no ambiente do filho, montado por **lista permitida** (`packages/core/src/child-env.ts`). |
| Senhas | Gerenciador de Credenciais via `@napi-rs/keyring`, com `new Entry('abap-adt-mcp', <perfil>)`, que gera o alvo `<perfil>.abap-adt-mcp`. **Não usar `Entry.withTarget()`**: no Windows, uma Entry nova criada assim lê a senha como vazia (testado da 1.3.0 à 2.1.2). Persistência: enterprise (roaming), padrão da biblioteca. |
| Certificados | `NODE_USE_SYSTEM_CA=1` (repositório do Windows) + `NODE_EXTRA_CA_CERTS` (certificado confiado só no perfil). **Não usar `SAP_CA_FILE`**: ele descarta as CAs do Windows. `TLS_REJECT_UNAUTHORIZED=1` sempre. |
| Proxy | WinHTTP via koffi (`WinHttpGetIEProxyConfigForCurrentUser` + `WinHttpGetProxyForUrl`): o próprio Windows avalia PAC/WPAD. Chamadas **síncronas**, porque só assim o `GetLastError` é confiável. O resultado vira `HTTPS_PROXY`; o axios 1.18 do upstream faz túnel CONNECT, com TLS de ponta a ponta. Proxy com NTLM/Kerberos não é suportado (detectado e explicado). |
| koffi 3 | Ponteiros são BigInt. Para ler UTF-16 use `koffi.decode.string16(ptr)`; `decode(ptr, 'str16')` derruba o processo. |
| Filtro de ferramentas | No relay JSON-RPC (`packages/core/src/relay.ts`): tira as desligadas do `tools/list` e responde erro -32602 ao `tools/call` delas. `GetTableContents` vem desligada em QAS e PRD. Funciona nas eras moderna (2026-07-28) e legada (2025-11-25). |
| Erros | O upstream esconde detalhes (de propósito). O relay anexa orientação em pt/en; o diagnóstico em etapas é o `test` (`packages/core/src/probe.ts`). |
| Perfil bloqueado | Perfil inexistente, inválido, HTTP em PRD ou `.env` na pasta do upstream: o `serve` sobe mesmo assim, sem dados SAP, e toda chamada explica o que fazer. |
| Prova de conexão | O `serve` grava `state/serve-<perfil>.json` com o cliente MCP (`clientInfo`) que o iniciou. |
| Dados locais | `%LOCALAPPDATA%\abap-adt-mcp` (`ABAP_ADT_MCP_HOME` sobrepõe, para testes): `profiles.json`, `logs/`, `state/`, `certs/`. |
| Idioma | Idioma da interface do Windows (`ABAP_ADT_MCP_LANG=pt|en` força). |
| TypeScript | Node 24 roda `.ts` direto (type stripping): só sintaxe apagável (`erasableSyntaxOnly`), imports com `.ts`, sem parameter properties nem enums. TypeScript 7 só para checagem de tipos (`npm run typecheck`). |

## Estrutura

- `packages/core/src`: lógica compartilhada (perfis, credenciais, proxy, certificados, relay, teste, logs, mensagens).
- `apps/cli/src`: o executável (`main.ts`, `serve.ts`, `test-command.ts`, `profile-command.ts`).
- `scripts/`: `build-upstream.mjs` e `build-cli.mjs` (SEA para x64 e ARM64).
- `vendor/mcp-abap-adt`: o upstream, intocado.
- `docs/`: plano da fase 0 e guia de desenvolvimento.

## Pendências conhecidas

- Interface Electron, assistente, integração automática com o Claude e instalador (fases 2 a 4).
- Manifesto de integridade do upstream verificado no `serve` (fase 4, junto com o empacotamento).
- Assinatura de código: certificado de pessoa física, a decidir (fase 4).
- Respostas reais do SAP para senha expirada ou usuário bloqueado: medir no QAS (fase 2).
