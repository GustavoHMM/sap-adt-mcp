# Roteiro de teste em máquina limpa (a cada versão)

Objetivo: provar que uma pessoa sem conhecimento técnico instala e usa o app num Windows "zerado", **sem administrador**, em x64 e ARM64.

## Ambientes

| Ambiente | Para quê | Como preparar |
|---|---|---|
| **Windows 11 x64, VM nova com usuário padrão** (não administrador) | Teste completo, incluindo "sem admin" | Crie a VM, crie um usuário local **padrão** e faça todo o teste com ele |
| **Windows 11 ARM64, VM nova com usuário padrão** (ex.: Parallels) | Mesmo teste em ARM64 | Igual ao de cima |
| **Windows Sandbox** (Windows Pro/Enterprise, x64) | Teste rápido de instalação e assistente | O usuário do Sandbox é administrador, então ele **não** substitui o teste "sem admin" |
| Opcional: rede com proxy corporativo e/ou VPN | Proxy, PAC/WPAD, inspeção TLS | Rede real do cliente |

Nenhum dos ambientes deve ter Node.js, Git, npm, Python nem o repositório do projeto.

## Roteiro

Anote ✔ ou ✖ e o que aconteceu em cada item.

### 1. Download e instalação
1. Baixe `ABAP-ADT-MCP-Setup-<versão>.exe` do GitHub Releases pelo navegador.
2. Execute. **Não pode aparecer pedido de administrador (UAC).**
   - Sem assinatura, o SmartScreen mostra "O Windows protegeu o computador": use "Mais informações → Executar assim mesmo" e anote isso. Com assinatura, anote se o aviso aparece (reputação ainda baixa) ou não.
3. A instalação termina sozinha e o app abre no **assistente**.
4. Confira o atalho "ABAP ADT MCP" no menu Iniciar.
5. Confira as pastas criadas: `%LOCALAPPDATA%\Programs\ABAP ADT MCP` (instalação) e `%LOCALAPPDATA%\abap-adt-mcp\runtime\current` (junction para a versão).

### 2. Assistente e teste de conexão
1. Cole a URL do SAP copiada do navegador, com caminho e `?sap-client=`. O app deve explicar o ajuste e preencher o mandante.
2. Preencha usuário, senha e ambiente (DEV/QAS/PRD). Confira o nome sugerido (ex.: "QAS 400").
3. Clique em "Salvar e testar". Todas as etapas devem aparecer, em linguagem simples.
4. Se houver certificado próprio da empresa, confira o botão "Confiar neste certificado só no perfil".
5. Etapa "Acesso ao Claude": anote o resultado, com e sem VPN.

### 3. Claude
1. **Sem o Claude instalado:** o passo 3 mostra "Não encontramos o Claude" e o botão "Baixar o Claude". Instale o Claude, volte para a janela e confira se o app detecta sozinho.
2. Conecte ao Claude Desktop e ao Claude Code. Aceite "Reiniciar agora" (ou "Abrir agora").
3. No Claude Desktop, pergunte: "mostre o código do programa SAPMV45A" (ou outro programa existente). O Claude deve usar o `abap-adt-<perfil>`.
4. No Claude Code, abra uma sessão nova e faça a mesma pergunta.
5. Na tela Claude, confira "Conectado" e "usado em <data>" nos dois.

### 4. Segurança (conferência rápida)
1. Abra as configs do Claude (o caminho aparece na tela Claude). Só pode haver o executável e `serve --profile <id>`. **Nenhum `SAP_*` e nenhuma senha.**
2. Rode `cmdkey /list | findstr abap-adt-mcp`: a credencial `<perfil>.abap-adt-mcp` deve existir.
3. Em `%LOCALAPPDATA%\abap-adt-mcp\profiles.json` e em `logs\`, procure a senha: ela não pode aparecer.
4. Num perfil PRD, "Conectar" deve pedir que você digite o identificador.

### 5. Bandeja e início com o Windows
1. Feche a janela: o app continua na bandeja, com um aviso na primeira vez.
2. No menu da bandeja, use "Testar <perfil>". A janela deve abrir no teste.
3. Em Sobre, ligue "Iniciar com o Windows". Saia e entre de novo na sessão do Windows: o app deve estar só na bandeja.

### 6. Atualização
1. Com a versão N instalada e conectada ao Claude, publique a versão N+1 no Releases.
2. Abra o app (ou espere até 6 h). Em Sobre deve aparecer "Baixando…" e depois "Reiniciar e atualizar".
3. Clique e confira: o app reabre na versão N+1, os perfis e as senhas continuam, `runtime\current` aponta para N+1 e o Claude continua funcionando **sem reconectar**.

### 7. Desinstalação
1. Configurações do Windows > Apps > ABAP ADT MCP > Desinstalar. Não pode pedir administrador.
2. À pergunta "Apagar também os perfis…", responda **Não**. As entradas `abap-adt-*` saem das configs do Claude, os backups ficam em `%LOCALAPPDATA%\abap-adt-mcp\backups` e os perfis continuam.
3. Reinstale: os perfis voltam, e é preciso reconectar ao Claude.
4. Desinstale de novo e responda **Sim**: a pasta `%LOCALAPPDATA%\abap-adt-mcp` e as credenciais `*.abap-adt-mcp` somem.

### 8. Repita tudo em ARM64

## Registro

| Versão | Ambiente | Data | Resultado | Observações |
|---|---|---|---|---|
| | | | | |
