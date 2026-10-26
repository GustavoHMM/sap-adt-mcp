# Checklist de lançamento

Copie esta lista para a issue ou para as notas de cada versão e marque cada item. Os comandos são para PowerShell, na raiz do repositório.

## Uma vez, antes da primeira versão pública

- [ ] Código no GitHub (`GustavoHMM/sap-adt-mcp`) e CI verde em x64 e ARM64.
- [ ] Repositório: Issues ligadas, branch `main` protegida e, em Settings › Actions, permissão de escrita para o job de empacotamento criar releases (o workflow já pede `contents: write`).
- [ ] Certificado de assinatura comprado e segredos `WINDOWS_SIGN_COMMAND` e `WINDOWS_SIGNTOOL` configurados ([assinatura-de-codigo.md](assinatura-de-codigo.md)). **Até lá, publique só como pré-lançamento, para testes internos:** sem assinatura, o Smart App Control bloqueia o app em Windows 11 novos.
- [ ] Ícone: o desenho lembra as marcas da SAP e da Anthropic. Decidir se mantém (risco de marca) ou troca antes de divulgar.
- [ ] Validação com o Claude Desktop real, incluindo o reinício feito pelo app.
- [ ] Validação no SAP real (QAS) numa rede em que o Claude também funcione (depende da exceção ou do certificado do TI da empresa).

## A cada versão

### 1. Código

- [ ] O upstream continua fixo no commit esperado. Se foi atualizado, siga "Atualizar o upstream" em [desenvolvimento.md](desenvolvimento.md) e regenere o manifesto: `npm.cmd run upstream:build`.
- [ ] Textos novos existem em pt e en (o `typecheck` acusa chave faltando no inglês).
- [ ] `version` do `package.json` da raiz atualizada (ex.: `0.2.0`).
- [ ] Tudo verde localmente:
  ```powershell
  npm.cmd run check
  npm.cmd run build:cli
  $env:ABAP_ADT_MCP_CLI_EXE = "$PWD\build\cli\win-$($env:PROCESSOR_ARCHITECTURE.ToLower() -replace 'amd64','x64')\abap-adt-mcp.exe"; npm.cmd run test:exe; Remove-Item Env:ABAP_ADT_MCP_CLI_EXE
  npm.cmd run test:desktop
  ```
- [ ] `npm.cmd audit --omit=dev` sem vulnerabilidade alta ou crítica nas dependências que vão no instalador.

### 2. Build

- [ ] Commit da versão, tag e push (o push é sempre feito ou autorizado pelo dono):
  ```powershell
  git tag v0.2.0
  git push origin main v0.2.0
  ```
- [ ] O GitHub Actions passou nos testes de x64 e ARM64 e criou o **rascunho** de release com o instalador, o `.blockmap` e o `latest.yml`.
- [ ] Baixe o instalador do rascunho e confira a assinatura (quando houver certificado):
  ```powershell
  Get-AuthenticodeSignature .\ABAP-ADT-MCP-Setup-0.2.0.exe | Format-List Status, SignerCertificate
  ```
  Depois de instalar, confira também `ABAP ADT MCP.exe` e `resources\cli\abap-adt-mcp.exe` na pasta de instalação.

### 3. Teste manual

- [ ] Roteiro de [teste-maquina-limpa.md](teste-maquina-limpa.md) em x64 e ARM64, com usuário **padrão** (sem administrador).
- [ ] Atualização da versão anterior para esta (item 6 do roteiro): perfis, senhas e conexões com o Claude continuam funcionando sem reconectar.
- [ ] Contra um SAP real: certificado próprio da empresa, proxy (se houver) e VPN.
- [ ] Pacote de diagnóstico: em Sobre, gere o pacote, abra o `.zip` e procure a senha, o usuário do SAP e o seu usuário do Windows. Nenhum pode aparecer.

### 4. Segurança e privacidade

- [ ] Configs do Claude (Desktop e `.claude.json`) só com o caminho do executável e `serve --profile <id>`: nenhuma variável `SAP_*` e nenhuma senha.
- [ ] `profiles.json`, `logs\` e `state\` sem senha, cookie ou token CSRF.
- [ ] Verificação de TLS nunca desligada. Os únicos `rejectUnauthorized: false` do código são as conexões que **só leem o certificado** para mostrá-lo (`probe.ts` e `claude-check.ts`) e nunca enviam dados:
  ```powershell
  git grep -n "rejectUnauthorized: false" -- packages apps
  ```
- [ ] Nenhuma conexão nova: o app só acessa o SAP configurado, o GitHub (atualizações) e, no teste, `claude.ai` e `api.anthropic.com` (checagem anônima).
- [ ] `THIRD-PARTY-NOTICES.md` gerado no build e incluído no instalador; `LICENSE` com o crédito ao mcp-abap-adt.

### 5. Publicação

- [ ] Notas da versão no rascunho: o que mudou, em linguagem simples (pt, com um resumo em en).
- [ ] Publique o rascunho como versão normal (não como pré-lançamento): o atualizador automático ignora pré-lançamentos.
- [ ] Num computador com a versão anterior, confira que a atualização chega (ao abrir o app ou em até 6 h).
- [ ] O link de download do README (`releases/latest`) aponta para esta versão.

### 6. Depois

- [ ] Acompanhe as Issues nos primeiros dias. Peça o pacote de diagnóstico em todo relato de problema.
- [ ] Se a versão tiver um problema grave: volte o release para rascunho (novos downloads deixam de pegá-lo) e publique a correção como uma versão **maior** (ex.: `0.2.1`). O atualizador não instala versões menores que a atual.
