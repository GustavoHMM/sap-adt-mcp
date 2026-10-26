# ABAP ADT MCP

Conecta o **Claude** (Claude Desktop e Claude Code) ao seu **SAP**, para você perguntar sobre programas, classes, tabelas e outros objetos ABAP em linguagem natural.

- **Somente leitura.** O Claude lê código e definições; nada é alterado no SAP.
- **Sem configuração técnica.** Um assistente pede os dados do SAP, testa a conexão e liga o Claude com um clique.
- **Senha protegida.** Fica só no Gerenciador de Credenciais do Windows, nunca em arquivos.
- **Sem telemetria.** O app só se conecta ao SAP que você configurou, ao GitHub (para buscar atualizações) e, durante o teste, confere se os servidores do Claude estão acessíveis.

> *English: this README is in Portuguese. The app itself follows the Windows language (Portuguese or English).*

---

## O que você precisa

- Windows 10 ou 11 (x64 ou ARM). **Não precisa ser administrador.**
- O **Claude Desktop** instalado ([baixar](https://claude.ai/download)). Ele já inclui o Claude Code. Se você usa só o Claude Code, também funciona.
- Os dados do SAP que você usa no Eclipse ADT ou no navegador: endereço, mandante, usuário e senha.
- Estar na rede da empresa (ou na VPN), como quando você acessa o SAP normalmente.

## Instalar

1. Baixe o arquivo **ABAP-ADT-MCP-Setup-*versão*.exe** na página de [versões](https://github.com/GustavoHMM/sap-adt-mcp/releases/latest).
2. Dê dois cliques no arquivo. A instalação é rápida e não pede senha de administrador.
3. O app abre sozinho no fim.

> **Se aparecer "O Windows protegeu o computador":** clique em **Mais informações** e depois em **Executar assim mesmo**. O aviso aparece porque esta versão ainda não tem assinatura digital. Se a sua empresa bloquear programas sem assinatura, peça ajuda ao TI.

## Configurar (5 minutos)

O assistente tem quatro passos.

**1. Dados do SAP**

| Campo | O que colocar |
|---|---|
| Endereço do SAP | Cole o endereço que você usa no navegador ou no Eclipse ADT. O app ajusta sozinho (tira caminhos extras e lê o mandante se ele vier no endereço). |
| Mandante | Três dígitos, como 400. |
| Idioma de logon | Duas letras, como PT ou EN. |
| Usuário e senha | Os mesmos do SAP. A senha vai direto para o Gerenciador de Credenciais do Windows. |
| Tipo de ambiente | Desenvolvimento, Qualidade ou Produção. |
| Nome amigável | Como você reconhece o sistema. Ex.: "QAS 400". |

Clique em **Salvar e testar**.

**2. Teste**

O app testa, passo a passo, tudo o que o Claude vai usar: endereço, proxy, nome do servidor, conexão de rede, certificado, login no SAP, token de segurança, o servidor do Claude e o acesso ao Claude pela sua rede. Quando algo falha, aparece uma explicação e, sempre que possível, um botão que resolve. Veja [Resolver problemas](#resolver-problemas).

**3. Claude**

Escolha onde usar o perfil: **Claude Desktop**, **Claude Code** ou os dois. O Claude Desktop só lê a configuração nova ao reiniciar; o app pergunta antes de reiniciá-lo, porque conversas em andamento são interrompidas.

**4. Pronto**

Abra o Claude e pergunte, por exemplo:

- "Mostre o código do programa SAPMV45A"
- "Quais campos tem a tabela VBAK?"
- "Procure classes que começam com ZCL_VENDAS e explique o que cada uma faz"

Dica: na tela **Claude**, o botão **Copiar instruções de uso** gera um texto para colar num projeto do Claude. Ele ensina o Claude a usar bem as ferramentas deste perfil.

## Usar no dia a dia

- **Vários sistemas:** crie um perfil para cada (DEV, QAS, PRD, mandantes diferentes). No Claude, cada um aparece com o nome `abap-adt-<perfil>`.
- **Janela fechada:** o Claude continua usando o SAP mesmo com o app fechado. O app fica na bandeja, perto do relógio, e pode iniciar com o Windows (opção em **Sobre**).
- **Trocar a senha:** em **Perfis**, edite o perfil e digite a nova senha. Deixe o campo em branco para manter a atual.
- **O que o Claude pode ler:** na tela **Claude**, o botão **Ferramentas** mostra a lista. Todas são somente leitura. A leitura do **conteúdo de tabelas** (dados de negócio) vem desligada em Qualidade e Produção.
- **Produção:** para ligar um perfil de produção ao Claude, o app pede que você digite o identificador do perfil, como confirmação.
- **Atualizações:** o app baixa novas versões sozinho e mostra **Reiniciar e atualizar**. Perfis, senhas e conexões com o Claude continuam como estão.

## Resolver problemas

Comece sempre pela tela **Teste**: ela mostra em que passo está o problema.

| O teste diz | O que fazer |
|---|---|
| **Não encontrei o servidor** / **O servidor não respondeu** | Confira se a VPN está conectada e se o endereço está certo (copie de novo do navegador ou do Eclipse). |
| **O certificado do servidor não é confiável** | Comum em SAP com certificado próprio da empresa. Confira a impressão digital com o time de Basis e clique em **Confiar neste certificado**. A confiança vale só para esse perfil. |
| **O certificado não vale para este nome** | Clique no botão **Usar *nome*** que aparece: ele troca o endereço por um dos nomes do certificado. |
| **O SAP redirecionou** | Clique no botão que troca o endereço pelo endereço final. |
| **Usuário ou senha incorretos** | Digite a senha de novo no próprio teste. Cuidado: muitas tentativas erradas bloqueiam o usuário no SAP. Se a senha estiver certa, peça ao Basis para verificar o seu usuário. |
| **Sem autorização para o ADT** / **Serviço ADT não está ativo** | Use **Copiar texto para o Basis** e envie para o time de SAP. |
| **O proxy exige autenticação** | Peça ao TI uma exceção no proxy para o endereço do SAP, ou conecte a VPN para acesso direto. |
| **Acesso ao Claude** (aviso) | O SAP pode estar ok, mas a sua rede (geralmente a VPN) bloqueia ou intercepta o tráfego do Claude. Use **Copiar texto para o TI**. |

**No Claude, as ferramentas do SAP não aparecem**

1. Na tela **Claude** do app, confira se o perfil está **Conectado**. Se estiver **Desatualizado** ou **Removido por outro programa**, clique em **Reconectar**.
2. Reinicie o Claude Desktop (ou abra uma nova sessão do Claude Code).

**O Claude mostra um erro ao usar o SAP**

A própria mensagem explica o que fazer (senha errada ou vencida, VPN desligada, perfil apagado...). Em caso de dúvida, rode o teste do perfil no app.

### Pedir ajuda

Em **Sobre**, clique em **Gerar pacote de diagnóstico**. O app salva um arquivo `.zip` (por padrão, na Área de Trabalho) e abre a pasta para você anexar num e-mail ou chamado.

O pacote junta os registros do app, a versão do Windows, a configuração de proxy, o estado das conexões com o Claude e um teste de rede feito **sem a senha**. Ele **não contém** senhas, cookies, tokens de segurança, nomes de usuário do SAP nem o seu nome de usuário do Windows.

Problemas e sugestões: [abra um chamado no GitHub](https://github.com/GustavoHMM/sap-adt-mcp/issues) (anexe o pacote de diagnóstico).

## Para o time de Basis e TI

- **SAP:** o mesmo acesso do Eclipse ADT. Serviço ICF `/sap/bc/adt` ativo, login com usuário e senha (Basic) e o usuário com autorização para usar o ADT. O app lê pelo protocolo HTTPS do ADT e não grava nada.
- **Rede:** o computador precisa alcançar o SAP (HTTPS) e os servidores do Claude (`claude.ai`, `api.anthropic.com`). O proxy do Windows (inclusive PAC/WPAD) é respeitado; proxy com autenticação NTLM ou Kerberos ainda não é suportado.
- **Certificados:** o app usa os certificados confiáveis do Windows. A verificação de TLS nunca é desligada. Um certificado próprio do SAP pode ser confiado só no perfil, depois de conferido.
- **Dados:** o que o Claude lê do SAP (código, definições e, se a ferramenta estiver ligada, conteúdo de tabelas) entra na conversa e é processado pela Anthropic, como qualquer conteúdo compartilhado com o Claude, segundo os termos do plano do Claude usado. Por isso a leitura de conteúdo de tabelas vem desligada em Qualidade e Produção, e perfis de produção exigem confirmação.
- **Segurança:** a senha fica no Gerenciador de Credenciais do Windows. A configuração do Claude recebe só o caminho do programa e o nome do perfil. HTTP sem criptografia exige confirmação e é bloqueado em perfis de produção.
- **Instalação:** por usuário, em `%LOCALAPPDATA%\Programs\abap-adt-mcp`, sem administrador. Dados em `%LOCALAPPDATA%\abap-adt-mcp`. Instalação silenciosa: `ABAP-ADT-MCP-Setup-<versão>.exe /S`.

## Desinstalar

**Configurações do Windows › Aplicativos › Aplicativos instalados › ABAP ADT MCP › Desinstalar.**

O desinstalador tira os perfis do Claude Desktop e do Claude Code (com backup da configuração) e pergunta se deve apagar também os perfis e as senhas guardadas. Responda **Não** se pretende instalar de novo.

## Créditos e licença

Usa, sem modificações, o servidor [mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt), de mario-andreschak, sob licença MIT. As licenças de todos os componentes estão em **Sobre › Licenças de terceiros**.

Este projeto é distribuído sob a [licença MIT](LICENSE). Não é afiliado à SAP nem à Anthropic. SAP e ABAP são marcas da SAP SE; Claude é marca da Anthropic.

Para desenvolver ou compilar o app, veja [docs/desenvolvimento.md](docs/desenvolvimento.md).
