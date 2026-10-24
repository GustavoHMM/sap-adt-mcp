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

## Onde ficam os dados durante o desenvolvimento

- Perfis, logs e estado: `%LOCALAPPDATA%\abap-adt-mcp` (os testes usam pastas temporárias via `ABAP_ADT_MCP_HOME`).
- Senhas: Gerenciador de Credenciais do Windows > Credenciais do Windows > genéricas > `<perfil>.abap-adt-mcp`.
