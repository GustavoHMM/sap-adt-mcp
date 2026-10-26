# Guia de desenvolvimento

## Requisitos da máquina de desenvolvimento

- Windows 10/11 (x64 ou ARM64)
- Node.js **24.22 ou superior, na linha 24** (o mesmo LTS embutido no produto)
- Git (o Git for Windows traz o `openssl` usado nos testes)

O usuário final não precisa de nada disso.

## Primeira vez

```powershell
git clone --recurse-submodules <repo> C:\Projetos\abap-adt-mcp
cd C:\Projetos\abap-adt-mcp
npm.cmd install
npm.cmd run upstream:build
```

Use sempre `npm.cmd` e `npx.cmd` no PowerShell. A política padrão de execução do Windows bloqueia o `npm.ps1` e o `npx.ps1`.

O npm 11 bloqueia scripts de instalação por padrão, e é assim que queremos. O esbuild e a koffi funcionam sem eles, porque os binários prontos vêm em subpacotes por plataforma.

## Dia a dia

```powershell
npm.cmd run typecheck                      # TypeScript 7, só checagem
npm.cmd test                               # todos os testes (ADT simulado, Gerenciador de Credenciais, WinHTTP)
npm.cmd run cli -- version                 # a CLI direto do código-fonte
npm.cmd run cli -- test --profile QAS400   # teste de conexão em etapas
```

O Node 24 executa os arquivos `.ts` diretamente. Por isso o código só pode usar sintaxe "apagável": nada de `enum`, `namespace` ou `constructor(readonly x)`, e os imports levam a extensão `.ts`.

## App (interface Electron)

```powershell
npm.cmd run desktop                         # compila e abre o app
npm.cmd run desktop:build                   # só compila (apps/desktop/out)
npm.cmd run test:desktop                    # compila e pilota a janela real (Playwright)
```

Em desenvolvimento, o app usa `build\cli\win-<arq>\abap-adt-mcp.exe` para o teste de conexão, quando existe. Senão, usa `node apps/cli/src/main.ts`. Para forçar o código-fonte, defina `ABAP_ADT_MCP_CLI_SOURCE` com o caminho do `node.exe`. Para salvar capturas de tela do teste da janela, defina `ABAP_ADT_MCP_SCREENSHOTS` com uma pasta.

## Diagnóstico de rede (VPN, proxy, Claude x SAP)

```powershell
node C:\Projetos\abap-adt-mcp\scripts\diagnostico-rede.mjs com-vpn
```

O script mede DNS, TCP, TLS (com o emissor do certificado) e um GET anônimo para a Anthropic e para cada perfil SAP. Também registra rotas padrão e configurações de proxy. O resultado vai para `build\diag`. Se a rede reassinar o tráfego (inspeção TLS), o certificado da CA da empresa é salvo ali para conferência com o TI. Rode uma vez com e outra sem VPN, e compare.

## Gerar o executável

```powershell
npm.cmd run build:cli                      # arquitetura desta máquina
node scripts/build-cli.mjs --arch all      # x64 e ARM64
```

A saída fica em `build/cli/win-<arq>/`:
- `abap-adt-mcp.exe`: Node 24.22.1 oficial, conferido por SHA-256, com o nosso código embutido (SEA);
- `node_modules/`: só os módulos nativos (`@napi-rs/keyring`, `koffi`);
- `upstream/`: o mcp-abap-adt compilado, com `UPSTREAM-INFO.json`.

O executável ainda **não é assinado**. Serve só para testes internos.

Para rodar os testes de ponta a ponta contra o executável, e não contra o código-fonte:

```powershell
$env:ABAP_ADT_MCP_CLI_EXE = 'C:\Projetos\abap-adt-mcp\build\cli\win-arm64\abap-adt-mcp.exe'
npm.cmd run test:exe
Remove-Item Env:ABAP_ADT_MCP_CLI_EXE
```

Num Windows ARM64, o x64 também roda (por emulação), então dá para testar as duas arquiteturas na mesma máquina.

## Instalador e versões

```powershell
npm.cmd run package                                   # instalador universal (x64 + ARM64) em release\
node scripts/package.mjs --arch arm64                 # só uma arquitetura (mais rápido para testar)
npm.cmd run icons                                     # regenera icon.png, icon.ico e tray.png a partir do icon-source.webp
```

O que o instalador leva:
- `ABAP ADT MCP.exe` (Electron, com os *fuses* endurecidos);
- `resources\cli\` com a CLI `abap-adt-mcp.exe`, gerada em `build\cli-release` para não esbarrar no exe que o Claude estiver usando em `build\cli`;
- `THIRD-PARTY-NOTICES.md` e `LICENSE.txt`.

Ao abrir, o app instalado:
1. copia a CLI para `%LOCALAPPDATA%\abap-adt-mcp\runtime\<versão>`;
2. aponta a junction `runtime\current` para essa versão;
3. corrige as entradas do Claude que apontam para executáveis nossos.

As configs do Claude usam sempre `runtime\current\abap-adt-mcp.exe`, então uma atualização não muda nada nelas.

A desinstalação chama `abap-adt-mcp.exe uninstall-cleanup [--purge]`, nunca numa atualização. Ela remove só as entradas do Claude que apontam para esta instalação.

### Publicar uma versão

1. Ajuste `version` no `package.json` da raiz (ex.: `0.2.0`), faça o commit e crie a tag `v0.2.0`.
2. Faça o push da tag. O GitHub Actions testa em x64 e ARM64, gera o instalador universal e cria um **rascunho** de release com o `latest.yml`.
3. Revise o rascunho e publique. Os apps instalados encontram a versão nova em até 6 horas, ou ao abrir.

O dono do repositório vem de `GH_OWNER`. No Actions ele é preenchido sozinho com o dono do repositório. Num build local sem `GH_OWNER`, o app não procura atualizações.

## Atualizar o upstream

1. `cd vendor\mcp-abap-adt; git fetch; git checkout <novo-commit>; cd ..\..`
2. `npm.cmd run upstream:build` (o script recusa a compilação se houver alterações locais no upstream).
3. `npm.cmd run check` e `npm.cmd run build:cli`, depois `npm.cmd run test:exe` nas duas arquiteturas.
4. Revise o diff do upstream, com atenção a variáveis de ambiente, TLS, proxy e nomes de ferramentas, porque o relay e o `child-env` dependem disso.
5. Faça o commit do submódulo com a versão e o commit no texto.

## Testes contra um SAP real

Os testes automatizados usam um ADT simulado em HTTPS local. Contra um SAP real, use o teste de conexão:

```powershell
npm.cmd run cli -- test --profile QAS400
```

Cuidado: cada tentativa com senha errada conta para o bloqueio do usuário no SAP.

## Registro manual no Claude Code (até a fase 3 automatizar)

A CLI do Claude Code que vem com o Claude Desktop fica fora do PATH, numa pasta versionada (nesta VM: `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude-code\2.1.308\23655dab5580\claude.exe`). Ela serve para registrar e checar servidores, mas não está logada para conversas avulsas (`-p`).

```powershell
& '<caminho>\claude.exe' mcp add --scope user abap-adt-QAS400 '--' 'C:\Projetos\abap-adt-mcp\build\cli\win-arm64\abap-adt-mcp.exe' serve --profile QAS400
& '<caminho>\claude.exe' mcp get abap-adt-QAS400
```

O `'--'` vai entre aspas para o PowerShell 5.1 não engoli-lo. A entrada gravada em `~/.claude.json` tem só o executável e o perfil, sem nenhuma variável `SAP_*`. Para ver quem iniciou o servidor, confira `state\serve-<perfil>.json` (`clientName`).

Enquanto o Claude estiver usando o servidor, o Windows trava o `.exe`, e `npm.cmd run build:cli` falha ao substituí-lo. Feche as sessões do Claude ou remova o registro antes de recompilar (problema R8 do plano, resolvido de vez na fase 4).

## Onde ficam os dados durante o desenvolvimento

- Perfis, logs e estado: `%LOCALAPPDATA%\abap-adt-mcp` (os testes usam pastas temporárias via `ABAP_ADT_MCP_HOME`).
- Senhas: Gerenciador de Credenciais do Windows > Credenciais do Windows > genéricas > `<perfil>.abap-adt-mcp`.
