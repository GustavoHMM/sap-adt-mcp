# Fase 0 — Plano do projeto abap-adt-mcp

- **Data:** 23/10/2026
- **Status:** aprovado em 23/10/2026 ("pode seguir"). Respostas e decisões na seção 13.
- **Upstream analisado:** [mario-andreschak/mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt), commit `05bb510` (16/09/2026), `package.json` 1.2.0, licença MIT.

---

## 1. O que foi feito e verificado nesta fase

| Item | Resultado |
|---|---|
| Clonar e ler todo o upstream (`src/`, `src/lib/`, `src/handlers/`, `scripts/`, `docs/`, CI, Dockerfile, `server.json`) | Feito. Clone de referência em `C:\Projetos\mcp-abap-adt`, sem alterações. |
| `npm ci` + `npm run build` no Windows 11 ARM64 com Node 24.22.1 | OK |
| Testes do upstream nesse ambiente | jest: 34 OK e 12 pulados (os de SAP real são opt-in); protocolo moderno e legado: OK; cliente SDK: 2/2; rede/TLS local: 13/13 |
| MCP Inspector 2.12.0 contra o upstream, com dados SAP fictícios | O formulário funciona e os valores chegam ao servidor: o erro foi de rede, não de "variáveis ausentes". Com `MCP_INSPECTOR_SECRET_STORE=memory`, o catálogo em disco guardou só os **nomes** das variáveis, com valores vazios, e nada foi para o cofre do Windows. |
| Prova técnica: upstream rodando no runtime do Electron 45 (Node 24.22.0 + BoringSSL) | Protocolo: OK. Cliente: 2/2. Rede: 12/13. A única falha é diferença de texto: o BoringSSL escreve "self signed" e o OpenSSL, "self-signed". O comportamento (rejeitar) está correto. |
| Prova técnica: stdio no processo principal do Electron | **Não funciona no Windows.** O stdout funciona, mas o stdin termina na hora e nada do que o pai escreve chega. |
| Prova técnica: CAs do Windows | Node 24 e Electron 45 passam a confiar nas 32 CAs que só existem no repositório do Windows quando `NODE_USE_SYSTEM_CA=1`. Sem essa variável, não confiam. |
| Configuração real do Claude Desktop nesta VM | Instalação **MSIX** (`Claude_pzs8sxrjxfjjc`, 3.6556.2.0 ARM64). O arquivo que vale é `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json`, e não `%APPDATA%\Claude` (ver seção 4). |

**Pendente, porque depende de você:** rodar o upstream com o Inspector contra o QAS400, digitando a senha na hora. O roteiro está na seção 10.

---

## 2. O que o upstream faz (fatos que orientam o design)

1. **Contrato estável:** é um servidor MCP só por stdio, configurado por variáveis de ambiente: `SAP_URL` (só a origem), `SAP_USERNAME`, `SAP_PASSWORD`, `SAP_CLIENT`, `SAP_LANGUAGE` (2 letras), `SAP_CA_FILE` e `TLS_REJECT_UNAUTHORIZED`. Este último, com valor `0`, **desliga o TLS**, então o launcher sempre força `1`.
2. **`.env`:** o upstream carrega `<pasta do pacote>\.env` via dotenv. O dotenv não sobrescreve variáveis já definidas. Por isso o launcher define **todas** as variáveis explicitamente, mesmo vazias, e recusa iniciar se existir um `.env` na pasta do upstream. A pasta de instalação por usuário é gravável pelo próprio usuário.
3. **`SAP_CA_FILE` descarta as CAs do Windows:** com essa variável, o upstream usa `tls.rootCertificates`, que é só a lista Mozilla, mais o PEM informado. Por isso **não usaremos `SAP_CA_FILE`**. Usaremos `NODE_USE_SYSTEM_CA=1` (repositório do Windows) e `NODE_EXTRA_CA_CERTS` (certificado confiado só naquele perfil).
4. **Proxy já é seguro no upstream:** o axios 1.18.1, fixo no lockfile do upstream, lê `HTTPS_PROXY`/`NO_PROXY` e abre um túnel `CONNECT`. O TLS vai de ponta a ponta até o SAP, e a CA configurada continua valendo. O proxy não vê a senha. Então o launcher só precisa definir essas variáveis no processo filho e **limpar** as que vierem herdadas do Windows.
5. **Erros propositalmente genéricos:** o upstream devolve "SAP connection failed; verify SAP_URL, certificate trust and network access" ou "SAP request failed (HTTP 401)", sem detalhes, para não vazar dados. Logo, o diagnóstico em etapas (DNS, TCP, TLS, ADT) **tem que ser feito pelo nosso teste**, não pelo servidor.
6. **Comportamento de rede:** usa só Basic auth, com `sap-client` e `sap-language` como parâmetros de URL em toda requisição. Não segue redirecionamentos. Cada requisição tem 30 s e cada chamada de ferramenta, 60 s. O download máximo é 16 MiB e a resposta ao Claude é paginada em blocos de até 40 KB.
7. **GetTableContents:** faz `POST /sap/bc/adt/datapreview/freestyle` com `SELECT * FROM <tabela>`, ou seja, lê dados de negócio. GetPackage também usa POST, com token CSRF.
8. **Protocolo MCP:** o upstream usa o SDK 2 e aceita a era moderna (2026-07-28: `server/discover`, sem `initialize`) e a legada (2025-11-25). O filtro do launcher tem que funcionar nas duas.
9. **⚠ O pacote do npm não é o código do git.** O `mcp-abap-adt@1.2.0` publicado no npm (gitHead `9162258`, julho/2026) usa o SDK 1 e é **anterior** ao endurecimento de TLS e à rejeição de redirecionamentos. O código que você descreveu só existe no git (commit `05bb510`), e o `package.json` continua dizendo 1.2.0. **Decisão proposta:** empacotar a partir do commit fixo do git, nunca do npm, e mostrar no app "mcp-abap-adt 1.2.0 (git 05bb510)".

---

## 3. Arquitetura proposta

```
 Claude Desktop / Claude Code
        │  stdio (JSON-RPC)
        ▼
 abap-adt-mcp.exe serve --profile QAS400        ← executável de console (Node 24 LTS oficial embutido)
   ├─ lê o perfil (%LOCALAPPDATA%\abap-adt-mcp\profiles.json) e a senha (Gerenciador de Credenciais)
   ├─ resolve o proxy para a URL do SAP (WinHTTP: manual, PAC ou WPAD, avaliado pelo próprio Windows)
   ├─ monta um ambiente mínimo (lista permitida) + SAP_* + NODE_USE_SYSTEM_CA=1
   │    [+ NODE_EXTRA_CA_CERTS do perfil] [+ HTTPS_PROXY/NO_PROXY]
   ├─ filtro JSON-RPC: tira ferramentas desligadas do tools/list, bloqueia o tools/call delas
   │    e traduz erros (401/403/404) para orientações em português ou inglês
   │  stdio
   ▼
 processo filho (mesmo executável, modo interno) → upstream dist/index.js, INTACTO, commit fixo
        │  HTTPS (axios; túnel CONNECT quando há proxy)
        ▼
 SAP  /sap/bc/adt

 "ABAP ADT MCP.exe" (Electron, interface): assistente, Perfis, Teste, Claude, Sobre, bandeja
   ├─ grava a senha no Gerenciador de Credenciais
   ├─ roda o teste com `abap-adt-mcp.exe test --profile X --json` (o MESMO runtime do serve)
   └─ edita as configs do Claude, reinicia o Claude Desktop, atualiza o app
```

### Por que dois executáveis (interface e linha de comando)

1. **O processo principal do Electron não tem stdin no Windows** (provado nesta fase). Ele não pode ser o servidor stdio que o Claude chama.
2. A alternativa seria `ELECTRON_RUN_AS_NODE=1`, mas ela exige deixar ligado o *fuse* RunAsNode. Com isso, o executável assinado vira um interpretador Node genérico, um padrão que antivírus e EDR corporativos marcam como suspeito. Além disso, a config do Claude teria de levar uma variável extra e o caminho de um script.
3. **O upstream roda no runtime que o autor testa** (Node 24 + OpenSSL). No Electron, com BoringSSL, já apareceu uma diferença, e SAPs antigos tendem a expor diferenças sutis de TLS.
4. **O teste roda no mesmo runtime do servidor.** "Teste OK" passa a significar "vai funcionar no Claude".
5. Atualizar o Electron (interface) não mexe no caminho que o Claude usa.

**Como gerar o executável de console:** Node SEA (*single executable application*), isto é, o `node.exe` oficial do Node 24 LTS com o nosso launcher embutido, empacotado com esbuild. Se o SEA der problema (assinatura ou módulos nativos), o plano B é `node.exe` + script, com a config do Claude levando dois caminhos. A decisão sai de uma prova técnica no início da fase 1.

### Bibliotecas nativas

As duas usam N-API, então funcionam igual no Node e no Electron, e têm binários prontos para x64 e ARM64.

| Necessidade | Escolha | Justificativa | Alternativas descartadas |
|---|---|---|---|
| Senhas no Gerenciador de Credenciais | **@napi-rs/keyring 2.1.2** (19/10/2026) | Mantida pelo autor do napi-rs e baseada no crate Rust `keyring`. Traz binários prontos `win32-x64-msvc` e `win32-arm64-msvc`, sem compilação na instalação. O próprio MCP Inspector 2.x usa essa biblioteca. A keytar foi arquivada. | `safeStorage` do Electron: grava um blob DPAPI em arquivo, não no Gerenciador de Credenciais, e não existe no executável de console. Chamar `CredWriteW` por FFI: mais código nosso lidando com segredo. |
| Proxy do Windows, incluindo PAC/WPAD | **koffi 3.3.3** (FFI, MIT) chamando `WinHttpGetIEProxyConfigForCurrentUser` + `WinHttpGetProxyForUrl` | É o próprio Windows que baixa e avalia o PAC e descobre o WPAD, como o Edge faz. Não reimplementamos nada. | PowerShell: costuma ser bloqueado em empresas e é lento. Registro + `pac-resolver`: reimplementa o Windows e erra em casos de borda. |

### Regras de segurança no launcher

- **Ambiente do processo filho por lista permitida:** só `SystemRoot`, `TEMP`, `TMP`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA` e similares, mais as nossas variáveis. **Nunca** herdar `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `TLS_REJECT_UNAUTHORIZED`, `SSLKEYLOGFILE` (despeja as chaves TLS em arquivo), `*_PROXY` nem `SAP_*` do ambiente do usuário.
- `TLS_REJECT_UNAUTHORIZED=1` e `SAP_CA_FILE=` (vazio) sempre definidos.
- A senha nunca aparece em argumentos, arquivos, logs ou configs do Claude. Os logs passam por um filtro que remove senha, cookies, token CSRF, cabeçalho `Authorization` e nome de usuário.
- **Integridade:** na hora do build geramos um manifesto SHA-256 dos arquivos do upstream, e o `serve` confere esse manifesto antes de iniciar. Isso protege contra alteração na pasta de instalação, que é gravável pelo usuário.
- HTTP sem TLS: aviso destacado; em perfis PRD, bloqueado.
- **Ferramentas por perfil:** em DEV, todas ligadas; em QAS e PRD, `GetTableContents` desligada por padrão. Para conectar um perfil PRD ao Claude, a pessoa precisa confirmar de forma explícita, digitando o nome do perfil.
- **Telemetria:** nenhuma. O app só fala com o SAP configurado e com o GitHub Releases, para verificar atualizações.
- **Ameaça aceita:** um programa malicioso rodando com o seu usuário consegue ler o Gerenciador de Credenciais ou o ambiente de um processo seu. Esse limite é o mesmo de qualquer app que guarda segredos por usuário.

---

## 4. Integração com o Claude: o que encontrei

- **O caminho da config do Claude Desktop muda com o tipo de instalação e com a versão.**
  - Nesta VM (MSIX 3.6556), a config real é `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json`. Ela fica ao lado de `config.json` e de um `README.txt` do próprio Claude.
  - Em `%APPDATA%\Claude` e em `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude` existe só um marcador `.user-data-left.claude_pzs8sxrjxfjjc`.
  - Relatos da comunidade sobre versões anteriores apontam para o caminho `LocalCache` ([issue #26073](https://github.com/anthropics/claude-code/issues/26073)). Instalações tradicionais (Squirrel) usam `%APPDATA%\Claude`. Há também relatos de que o Claude Desktop apaga essa config depois de atualizar.
  - **Proposta:**
    1. Detectar por uma lista de candidatos, priorizando onde houver dados ativos e ignorando pastas com o marcador `.user-data-left`.
    2. **Comprovar** a conexão: o `serve` registra quando foi iniciado e por qual cliente, e o app mostra "conectado e em uso" só com essa prova.
    3. Vigiar a config e oferecer restaurar o backup se ela sumir ou mudar.
- **Claude Desktop e Claude Code têm o mesmo nome de processo (`claude.exe`).** Para reiniciar, identificamos o processo **pelo caminho**, nunca pelo nome. Reiniciar o Claude Desktop **interrompe conversas e sessões da aba Code**, então sempre pedimos permissão com esse aviso. No MSIX, a reabertura é pelo AUMID do pacote.
- **Claude Code, escopo de usuário:**
  - O registro fica em `~/.claude.json`, na chave `mcpServers` do topo.
  - A CLI não está no PATH desta VM. O Claude Desktop traz uma cópia em `%LOCALAPPDATA%\Claude-Data\...\claude-code\<versão>\...\claude.exe`, e a instalação nativa fica em `~/.local/bin/claude.exe`.
  - **Método:** usar `claude mcp add-json <nome> '<json>' --scope user` quando a CLI for encontrada. Na falta dela, editar `~/.claude.json` de forma atômica, com backup e validação.
  - No Windows, o Claude Code fecha o stdin e encerra a árvore de processos depois de 300 ms. O `serve` precisa encerrar o filho rápido.
- **Políticas corporativas** (`managedMcpServers`/`managed-mcp.json` no Claude Code, configurações de administrador no Claude Desktop) podem bloquear servidores locais. Quando der para detectar, o app explica o bloqueio em vez de falhar calado.

---

## 5. Stack: comparação e recomendação

| Critério | **Electron + CLI Node 24 (recomendado)** | Só Electron (RunAsNode) | Tauri + Node sidecar | .NET (WinUI/WPF) + Node sidecar |
|---|---|---|---|---|
| Zero dependências na máquina | ✅ Chromium e Node embutidos | ✅ | ⚠ precisa do WebView2: vem no Win11; no Win10 quase sempre, mas não em toda imagem corporativa; o instalador offline acrescenta ~180 MB | ✅ self-contained |
| x64 + ARM64 | ✅ builds oficiais | ✅ | ✅ (Rust para aarch64) | ✅ |
| Tamanho do instalador (estimativa) | ~130 MB por arquitetura; ~260 MB no instalador único com as duas | ~100 MB | ~40 MB | ~70–90 MB |
| Atualização automática | ✅ electron-updater: maduro, diferencial e usa o proxy do sistema (inclusive NTLM, via Chromium) | ✅ | ✅ plugin updater, com chaves próprias | ⚠ exige terceiros (Velopack etc.) |
| Instalador por usuário, sem admin, escolhendo a arquitetura | ✅ NSIS do electron-builder (`oneClick`, `perMachine:false`, instalador universal nativo) | ✅ | ⚠ sem instalador multi-arquitetura nativo | ⚠ montar à parte |
| Assinatura | ✅ hook do electron-builder (signtool, Artifact Signing, nuvem) | ✅ | ✅ `signCommand` | ✅ |
| Manutenção para você | ✅ **uma linguagem só (TypeScript)** em interface, CLI, testes e upstream | ✅ | ⚠ Rust + TS | ⚠ C# + TS |
| Riscos próprios | um runtime a mais para manter (Node LTS) | fuse aberto, BoringSSL, config do Claude mais complexa | WebView2, toolchain Rust | duas linguagens, Windows-only é ok |

**Recomendação: Electron + TypeScript, com o executável de console em Node 24 LTS (SEA).** É a opção mais segura para "zero pré-requisitos em qualquer Windows" e a mais simples de manter, porque tudo fica em TypeScript. Ela também tem o instalador e o atualizador mais maduros para instalação por usuário sem admin. O custo é o tamanho, mas para um app instalado uma vez isso é aceitável.

**Complementos propostos:**
- Interface: React + Vite + Fluent UI React v9, a linguagem visual do Windows 11, acessível.
- Idiomas: i18next (pt-BR/en).
- Monorepo: npm workspaces, com electron-vite para a interface, esbuild para a CLI e electron-builder 26.x para o instalador.
- Versões atuais (23/10/2026): Electron 45.0.0 (Node 24.22.0), electron-builder 26.15.3, Node 24 LTS (suporte de manutenção até abril/2028).

---

## 6. Build, distribuição e atualização

- **Script único** `npm run dist` (Windows/PowerShell). Ele:
  1. compila o upstream a partir do submódulo no commit fixo, com `npm ci`, `build` e `prune --omit=dev`;
  2. empacota a CLI;
  3. baixa o Node oficial de cada arquitetura, conferindo o `SHASUMS256`, e gera o SEA;
  4. compila a interface;
  5. gera os instaladores NSIS;
  6. gera os avisos de terceiros (`THIRD-PARTY-NOTICES`), que incluem as licenças do upstream (MIT, crédito a mario-andreschak), do Electron/Chromium, do Node e de cada dependência empacotada.
- **CI (GitHub Actions):** um job em `windows-latest` (x64) e outro em `windows-11-arm` (ARM64), com testes **nativos** nas duas arquiteturas, empacotamento, assinatura quando houver segredos e um rascunho de release. Os runners ARM64 são gratuitos em repositório público; em privado, consomem minutos pagos.
- **Instalador:**
  - NSIS por usuário em `%LOCALAPPDATA%\Programs\<app>`, sem admin;
  - atalho no menu Iniciar e o assistente abre ao terminar;
  - opção "iniciar com o Windows" (chave `HKCU\...\Run`);
  - perfis e credenciais ficam fora da pasta de instalação e sobrevivem a atualizações.
- **Arquiteturas:** um instalador universal (~260 MB), que escolhe a arquitetura sozinho, mais instaladores separados de ~130 MB para quem preferir.
- **Atualização automática:** electron-updater + GitHub Releases. O app verifica ao abrir e periodicamente, mostra o botão "Atualizar agora" e instala ao fechar.
- **Atualizar com o Claude usando o servidor:** o Windows trava o `.exe` em uso. **Proposta (validar na fase 4):**
  - o app copia a CLI para `%LOCALAPPDATA%\abap-adt-mcp\runtime\<versão>\`;
  - as configs do Claude apontam para um caminho estável, `runtime\current\abap-adt-mcp.exe`, onde `current` é uma *junction*, que não exige admin;
  - cada atualização cria a pasta nova e repõe o `current`;
  - os servidores em execução continuam na versão antiga até o Claude reiniciar, e versões velhas são limpas depois.
  - Com isso, a config do Claude não muda entre versões.
- **Desinstalador:** uma macro NSIS chama `abap-adt-mcp.exe uninstall-cleanup`, que remove as entradas do Claude (com backup) e pergunta se deve apagar perfis e credenciais.
- **Mais tarde:** instalador por máquina (Program Files, admin) para TI de empresas com AppLocker (ver risco R7).

---

## 7. Assinatura de código: opções

Opções para você, no Brasil. Fonte: [Microsoft, Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), atualizada em 29/08/2026.

| Opção | Custo | Disponível para você? | Processo | Observação |
|---|---|---|---|---|
| Azure Artifact Signing (ex-Trusted Signing) | ~US$ 9,99/mês | ❌ Pessoa física: só EUA/Canadá. Empresa: só EUA, Canadá, UE e Reino Unido. | — | Só com empresa num desses lugares. |
| Certificado OV de CA tradicional (DigiCert, Sectigo, GlobalSign, SSL.com, Certum) | US$ 150–300/ano (estimativa da Microsoft); assinatura em nuvem para CI geralmente cobra à parte | ✅ Algumas CAs validam pessoa física (por exemplo, Certum, SSL.com); empresa exige documentos do CNPJ. | Compra → validação de identidade (dias) → chave em token ou HSM em nuvem (obrigatório desde 2023) → configurar no CI | Caminho padrão fora dos EUA. |
| Certificado EV | US$ 400+/ano | ✅ | igual ao OV, com validação mais rígida | **Não evita mais o SmartScreen desde 2024.** Não compensa. |
| SignPath Foundation | gratuito | ✅ se o projeto for open source (repositório público, licença OSI, build no CI) | Inscrição e aprovação; a assinatura sai pelo pipeline deles | O certificado sai no nome da "SignPath Foundation". |
| Microsoft Store (MSIX) | gratuito; a Microsoft assina | ✅ | Conta de desenvolvedor gratuita e certificação | O MSIX virtualiza gravações em AppData/LocalAppData, o que conflita com editar as configs do Claude (exigiria uma capacidade restrita). Muitas empresas bloqueiam a Store. **Não para a v1**; talvez um canal extra depois. |
| Sem assinatura | — | só testes internos | — | SmartScreen com aviso forte. O **Smart App Control** (Windows 11 instalado do zero) **bloqueia sem opção de continuar**, e empresas podem bloquear. |

Mesmo assinado, um certificado novo mostra aviso do SmartScreen até ganhar reputação. Assinar todas as versões com a mesma identidade acelera isso.

**Pipeline:** um hook `scripts/sign.mjs` no electron-builder não faz nada quando não há segredos configurados, então os builds saem **não assinados** até você decidir. Tudo o que for executável será assinado:
- o executável da interface;
- a CLI SEA (a assinatura original do `node.exe` é removida antes de injetar o script, e o arquivo é assinado depois);
- os módulos `.node`;
- o desinstalador e o instalador.

---

## 8. Estrutura de pastas proposta (`C:\Projetos\abap-adt-mcp`)

```
abap-adt-mcp/
├─ CLAUDE.md                     decisões do projeto (criado após seu OK)
├─ README.md                     usuário final, pt-BR, sem jargão
├─ THIRD-PARTY-NOTICES.md        gerado no build
├─ docs/
│  ├─ fase-0-plano.md            este documento
│  ├─ desenvolvimento.md         como compilar, testar e liberar versões
│  ├─ arquitetura.md
│  ├─ seguranca.md               modelo de ameaças
│  ├─ assinatura-de-codigo.md
│  └─ teste-maquina-limpa.md     roteiro manual por versão (x64 e ARM64, sem admin)
├─ vendor/mcp-abap-adt/          submódulo git no commit fixo, intocado
├─ packages/core/                lógica compartilhada (TypeScript)
│  └─ src/  profiles, credentials, proxy, certs, claude-config, relay/filter,
│           diagnostics, adt-probe (etapas do teste), i18n
├─ apps/cli/                     abap-adt-mcp.exe (SEA): serve, test, profile, claude, uninstall-cleanup
├─ apps/desktop/                 Electron: main, preload, renderer (React + Fluent UI)
├─ test/
│  ├─ adt-mock/                  servidor ADT simulado em HTTPS local (mesma abordagem do upstream)
│  └─ live/                      testes contra SAP real (opt-in: RUN_SAP_LIVE=1)
├─ scripts/                      build, sign, notices, sea
└─ .github/workflows/            build.yml (x64 + ARM64)
```

**Dados em tempo de execução** (todos locais, nada no roaming):
- `%LOCALAPPDATA%\abap-adt-mcp\profiles.json`, sem segredos;
- `...\certs\<perfil>.pem`, só certificados públicos confiados;
- `...\logs\`, com rotação e filtro de dados sensíveis;
- `...\backups\`, com os backups das configs do Claude;
- no Gerenciador de Credenciais, uma credencial genérica `abap-adt-mcp:<perfil>`.

---

## 9. Riscos e mitigação

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| R1 | O caminho da config do Claude Desktop muda com o tipo de instalação e a versão, e há relatos de o Claude apagar a config | O Claude não vê o servidor | Detecção por candidatos, prova de uso pelo `serve`, vigilância da config e restauração com um clique |
| R2 | O npm e o git do upstream divergem com a mesma versão | Empacotar código sem o endurecimento de TLS | Vendorizar pelo commit SHA; nossos testes rodam contra o upstream a cada atualização dele |
| R3 | SAP antigo com chave RSA de 1024 bits, assinatura SHA-1 ou só TLS 1.0/1.1 | O OpenSSL 3 recusa, e afrouxar a segurança não é opção | Mensagem clara + texto pronto para o Basis renovar o PSE SSL Server (STRUST) |
| R4 | Proxy com autenticação NTLM/Kerberos | O Node/axios não suporta | Detectar `407` com `Proxy-Authenticate: NTLM/Negotiate` e explicar; avaliar uma solução se for comum nos seus clientes (pergunta P5) |
| R5 | Avaliar PAC/WPAD por FFI (código nativo em duas arquiteturas) | Falhas difíceis de reproduzir | Prova técnica na fase 1; se falhar, usar a configuração estática do registro e mostrar a mensagem "proxy automático não suportado" |
| R6 | Sem assinatura: o Smart App Control bloqueia e o SmartScreen assusta | A experiência "sem intervenção" quebra | Decidir a assinatura cedo (pergunta P3) |
| R7 | AppLocker ou WDAC corporativo bloqueiam executáveis em `%LOCALAPPDATA%` | Instalação por usuário não roda | Detectar e explicar; oferecer depois um instalador por máquina ou MSI para o TI |
| R8 | Atualizar enquanto o Claude usa o servidor (`.exe` travado) | Atualização falha | Pastas versionadas + junction `current` (seção 6) |
| R9 | Reiniciar o Claude Desktop interrompe conversas e sessões da aba Code | Perda de trabalho | Sempre perguntar, com esse aviso; reiniciar pelo caminho do processo, nunca pelo nome |
| R10 | `~/.claude.json` é reescrito pelo Claude Code em execução | Nossa edição se perde | Preferir a CLI `claude mcp add-json`; o fallback edita de forma atômica e confere o resultado depois |
| R11 | Comportamento do SAP com Basic auth para senha expirada, usuário bloqueado ou login básico desativado | Mensagens erradas | **Não vou chutar.** Testar no seu QAS com um usuário de teste (pergunta P6) |
| R12 | Idioma do Windows (ex.: PT) não instalado no SAP | Falha de logon | Testar no seu QAS; se falhar, o teste oferece trocar para EN |
| R13 | Políticas corporativas do Claude bloqueiam servidores MCP locais | O servidor não carrega | Detectar quando possível e explicar o bloqueio |
| R14 | `@napi-rs/keyring` pode gravar a credencial com persistência "enterprise" (roaming) | A senha viaja no perfil móvel | Conferir na fase 1; preferir persistência local |
| R15 | A era moderna do MCP (2026-07-28) evolui | O filtro deixa de funcionar | Filtro só por método (`tools/list`, `tools/call`), com testes nas duas eras usando o cliente do SDK |
| R16 | Nome do produto com marcas "SAP" ou "Claude" | Questão de marca | Pergunta P1 |
| R17 | Windows 10 ARM64 não emula x64 | O build x64 não roda nele | Teremos build ARM64 nativo |
| R18 | A política de execução do PowerShell bloqueia scripts `.ps1` por padrão (aconteceu nesta VM com o `npx.ps1`) | Qualquer etapa que dependa de script PowerShell falha | O app e o instalador nunca dependem de PowerShell. Comandos de desenvolvimento usam `npm.cmd` e `npx.cmd`. |

---

## 10. Roteiro: rodar o upstream com o MCP Inspector contra o QAS400 (você executa)

A senha é digitada no navegador e fica **só na memória** do Inspector (`MCP_INSPECTOR_SECRET_STORE=memory`). Eu verifiquei isso nesta fase com valores fictícios: nada foi gravado no catálogo nem no Gerenciador de Credenciais. O campo de ambiente do Inspector **não esconde o texto**, então evite compartilhar a tela nessa hora.

1. Conecte a VPN, se o QAS400 exigir.
2. No PowerShell:
   ```powershell
   cd C:\Projetos\mcp-abap-adt
   $env:MCP_INSPECTOR_SECRET_STORE = 'memory'
   npx.cmd -y @modelcontextprotocol/inspector@2.12.0 --catalog "$env:TEMP\inspector-abap.json"
   ```
   Use `npx.cmd`, não `npx`. O PowerShell padrão do Windows (política `Restricted`) bloqueia o `npx.ps1`, e não precisamos mudar essa política.
   O navegador abre sozinho. Se não abrir, use o endereço com `MCP_INSPECTOR_API_TOKEN=` mostrado no terminal. Confirme que aparece a linha "Secrets: Memory (this session only)".
3. Clique em **Add Servers → + Add manually** e preencha:
   - **Server ID:** `abap-qas400`
   - **Transport:** stdio
   - **Command:** `node`
   - **Arguments:** `C:\Projetos\mcp-abap-adt\dist\index.js`
   - **Environment**, uma linha por variável:
     ```
     SAP_URL=https://<host>:<porta>
     SAP_CLIENT=400
     SAP_USERNAME=<seu usuário>
     SAP_LANGUAGE=PT
     SAP_PASSWORD=<digite a senha aqui>
     ```
4. Clique em **Add**. Depois, ligue a chave do card `abap-qas400`, que deve passar a mostrar "Connected".
5. Abra a aba **Tools**, que deve listar 16 ferramentas, e rode:
   - `SearchObject` com query `SAPMV45A` e maxResults `1`;
   - `GetProgram` com program_name `SAPMV45A` e maxLines `30`.
   - Não rode `GetTableContents` neste teste.
6. Para encerrar: feche a aba do navegador, aperte **Ctrl+C** no PowerShell e rode:
   ```powershell
   Remove-Item "$env:TEMP\inspector-abap.json"
   Remove-Item Env:MCP_INSPECTOR_SECRET_STORE
   ```
7. Me diga o resultado de cada passo. Em caso de erro, copie **só a mensagem**, sem a senha. Se der erro de certificado, me diga também se o QAS400 usa uma CA corporativa ou um certificado autoassinado do STRUST.

---

## 11. Perguntas para você

- **P1. Nome:** qual nome de produto e de executável usar? Proponho a interface "ABAP ADT MCP" e a CLI `abap-adt-mcp.exe`. Evitaria "SAP" ou "Claude" no nome, por causa das marcas. Quem aparece como editor ("publisher")?
- **P2. Repositório:** GitHub público e open source (MIT) ou privado?
  - Isso afeta a SignPath Foundation (exige open source), os runners ARM64 gratuitos (só em repositório público) e as atualizações.
  - O GitHub Releases de um repositório privado exige token no app, o que não serve. Seria preciso um repositório público só de releases.
- **P3. Assinatura:** você assinaria como pessoa física ou jurídica (CNPJ)? Qual orçamento por ano? Ou prefere open source + SignPath?
- **P4. Rede do QAS400:** o acesso a partir da VM é por VPN? A URL é `https://host:443` ou usa porta própria (ex.: 44300)?
- **P5. Proxy nos seus clientes:** o SAP costuma ser acessado direto (rede interna/VPN) ou por proxy? Algum cliente usa proxy com autenticação Windows (NTLM/Kerberos)?
- **P6. Comportamento do SAP:** você sabe o que o ICF devolve, com Basic auth no `/sap/bc/adt`, para senha **inicial ou expirada**, usuário **bloqueado** e Basic auth **desativado** na SICF?
  - Se não souber, dá para pedir ao Basis um usuário de teste no QAS? Assim mediríamos as respostas reais antes de escrever as mensagens.
- **P7. Login:** o upstream só suporta Basic auth. Clientes que só aceitam SSO (SAML, certificado X.509, Kerberos) ficam fora da v1. Tudo bem?
- **P8. Instalador:** o padrão seria o universal (~260 MB, escolhe a arquitetura sozinho) com os separados (~130 MB) como alternativa. Concorda?
- **P9. Interface:** React + Fluent UI (visual do Windows 11) está bom para você manter?
- **P10. Git:** não há nome e e-mail configurados no git desta VM. Que nome e e-mail uso nos commits?

---

## 12. Próximo passo: fase 1, depois do seu OK

1. **Provas técnicas, nas duas arquiteturas:** gerar o SEA; carregar `@napi-rs/keyring` e `koffi` a partir do SEA; WinHTTP com PAC; confirmar o tipo de persistência da credencial.
2. Criar o repositório `abap-adt-mcp` com o upstream como submódulo no commit `05bb510`.
3. Implementar o núcleo: perfis, credenciais, certificados (repositório do Windows + confiança por perfil), proxy, `serve` (relay + filtro + tradução de erros) e `test` (DNS → TCP → TLS → ADT → CSRF → MCP).
4. Criar testes automatizados com o servidor ADT simulado.
5. Registrar manualmente no Claude Code com o perfil QAS400 e provar que funciona.

---

## 13. Respostas e decisões (23/10/2026)

| Pergunta | Resposta | Consequência |
|---|---|---|
| P2 Repositório | **Público** | Runners ARM64 gratuitos e atualizações pelo GitHub Releases do próprio repositório. Licença do nosso código: **MIT** (proposta, igual à do upstream). |
| P3 Assinatura | **Pessoa física** | O Azure Artifact Signing não atende pessoa física no Brasil. Sobra certificado OV/IV de pessoa física numa CA que valide pessoa física (ex.: Certum, SSL.com), com chave em nuvem para o CI. A SignPath Foundation assina no nome dela, não no seu, então fica como plano B. A compra pode esperar até a fase 4; o pipeline fica pronto para assinar. |
| P6 Respostas do SAP | "Uma mensagem de erro" (sem detalhes conhecidos) | Vamos **medir** as respostas reais na fase 2. Cuidado: testar senha errada repetidas vezes pode **bloquear o usuário** (parâmetro `login/fails_to_user_lock`, que costuma ser 3 a 5 tentativas). O ideal é um usuário de teste. |
| P10 Git | Gustavo Maia, gustavo.hmm@gmail.com | Configurado só neste repositório (`git config` local). |
| P1, P4, P5, P7, P8, P9 | Sem resposta | Seguimos com as propostas: CLI `abap-adt-mcp.exe` e interface "ABAP ADT MCP"; só Basic auth na v1; instalador universal mais os separados; React + Fluent UI. Para o teste real da fase 1, ainda preciso da URL, do mandante e do usuário do QAS400 (nunca da senha). |
