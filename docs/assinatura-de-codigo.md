# Assinatura de código

Sem assinatura, o Windows mostra avisos (SmartScreen) e o **Smart App Control** bloqueia o app em instalações novas do Windows 11. Empresas também podem bloqueá-lo. Os builds atuais saem **sem assinatura** e servem só para testes internos.

## Situação e decisão

Você vai assinar como **pessoa física, no Brasil**. Isso exclui o Azure Artifact Signing (para pessoa física, só EUA e Canadá). Opções viáveis:

| Opção | Custo aproximado | Observação |
|---|---|---|
| Certificado de assinatura de pessoa física (IV/OV) em CA que atende pessoa física (ex.: Certum, SSL.com) | US$ 150–300/ano, mais a assinatura em nuvem para CI, se cobrada | Desde 2023 a chave fica em token ou HSM. Para o GitHub Actions, prefira a **assinatura em nuvem** do próprio fornecedor |
| SignPath Foundation | gratuito para projetos open source | Assina no nome da SignPath Foundation, não no seu |

Um certificado novo começa sem reputação no SmartScreen. Assinar **todas** as versões com a mesma identidade faz a reputação crescer.

## Como o pipeline assina

O electron-builder chama `scripts/sign.cjs` para cada arquivo a assinar: o instalador, o desinstalador, o executável do app, os módulos `.node` e o `abap-adt-mcp.exe`.

- Sem a variável `WINDOWS_SIGN_COMMAND`, nada é assinado. O log mostra `[sign] unsigned`.
- Com ela, o comando é executado trocando `{file}` pelo caminho do arquivo.
- O `abap-adt-mcp.exe` é o `node.exe` oficial com o nosso código injetado, e a assinatura original dele fica inválida depois da injeção. Defina `WINDOWS_SIGNTOOL` com o caminho do `signtool.exe` para a assinatura antiga ser removida antes da nova.

No GitHub: Settings > Secrets and variables > Actions > crie os segredos `WINDOWS_SIGN_COMMAND` (e `WINDOWS_SIGNTOOL`, se for o caso). O workflow já os repassa.

### Exemplos de comando

São formatos ilustrativos; confira a documentação do fornecedor escolhido.

- **signtool com certificado em HSM ou token acessível pelo Windows:**
  `"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <IMPRESSÃO_DO_CERTIFICADO> {file}`
- **Ferramenta de assinatura em nuvem do fornecedor** (ex.: CodeSignTool do SSL.com): um comando do tipo `CodeSignTool sign -username=... -password=... -credential_id=... -input_file_path={file} -override=true`, com as credenciais vindas de outros segredos.

Sempre use um carimbo de tempo (*timestamp*): ele mantém a assinatura válida depois que o certificado vencer.

## Conferência

Rode `Get-AuthenticodeSignature "<arquivo>"` no PowerShell. O resultado deve ser `Valid`, com o seu nome em `SignerCertificate`. Confira o instalador, o `ABAP ADT MCP.exe` e o `resources\cli\abap-adt-mcp.exe`.
