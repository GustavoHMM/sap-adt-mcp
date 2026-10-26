import type { Lang } from './messages.ts';
import type { Profile } from './profiles.ts';

/** The upstream's sixteen read-only tools (mcp-abap-adt 05bb510). New upstream tools are allowed by default. */
export const UPSTREAM_TOOLS: readonly { name: string; pt: string; en: string; businessData?: true }[] = [
  { name: 'GetProgram', pt: 'Código-fonte de programas', en: 'Program source code' },
  { name: 'GetClass', pt: 'Código-fonte de classes', en: 'Class source code' },
  { name: 'GetInterface', pt: 'Código-fonte de interfaces', en: 'Interface source code' },
  { name: 'GetFunctionGroup', pt: 'Código-fonte de grupos de funções', en: 'Function group source code' },
  { name: 'GetFunction', pt: 'Código-fonte de módulos de função', en: 'Function module source code' },
  { name: 'GetInclude', pt: 'Código-fonte de includes', en: 'Include source code' },
  { name: 'GetStructure', pt: 'Definição de estruturas', en: 'Structure definitions' },
  { name: 'GetTable', pt: 'Definição de tabelas', en: 'Table definitions' },
  { name: 'GetTypeInfo', pt: 'Domínios e elementos de dados', en: 'Domains and data elements' },
  { name: 'GetCDSView', pt: 'Código de CDS views', en: 'CDS view source' },
  { name: 'GetBehaviorDefinition', pt: 'Definições de comportamento (RAP)', en: 'Behavior definitions (RAP)' },
  { name: 'GetServiceDefinition', pt: 'Definições de serviço (RAP)', en: 'Service definitions (RAP)' },
  { name: 'GetPackage', pt: 'Conteúdo de pacotes', en: 'Package contents' },
  { name: 'GetTransaction', pt: 'Detalhes de transações', en: 'Transaction details' },
  { name: 'SearchObject', pt: 'Busca de objetos', en: 'Object search' },
  { name: 'GetTableContents', pt: 'Conteúdo de tabelas', en: 'Table contents', businessData: true },
];

/** Text to paste into a Claude project so Claude uses this profile's tools well. */
export function usageInstructions(profile: Profile, disabled: ReadonlySet<string>, lang: Lang): string {
  const server = `abap-adt-${profile.id}`;
  const enabled = UPSTREAM_TOOLS.filter((t) => !disabled.has(t.name));
  const list = enabled.map((t) => `- ${t.name}: ${lang === 'pt' ? t.pt : t.en}`).join('\n');
  const tableData = enabled.some((t) => t.businessData);
  if (lang === 'pt') {
    return [
      `Você tem acesso somente leitura ao SAP "${profile.name}" (${profile.environment}, mandante ${profile.client}) pelo servidor MCP "${server}".`,
      '',
      'Ferramentas disponíveis:',
      list,
      '',
      'Como usar:',
      '- Antes de ler um objeto pelo nome, confirme o nome e o tipo com SearchObject (use * como curinga, ex.: Z*VENDAS*).',
      '- Para fontes grandes, leia em partes com startLine e maxLines (ex.: maxLines 400). A resposta traz totalLines e hasMore; continue em startLine + returnedLines enquanto hasMore for verdadeiro.',
      '- GetFunction precisa do nome do módulo de função e do grupo de funções.',
      '- Ao responder, cite o objeto e as linhas de onde tirou cada trecho.',
      '',
      'Cuidados:',
      `- Este é um sistema ${profile.environment}; nada é alterado, mas trate o conteúdo como confidencial.`,
      tableData
        ? '- GetTableContents lê dados de negócio: use só quando eu pedir, com poucas linhas (max_rows), e não reproduza dados pessoais.'
        : '- A leitura de conteúdo de tabelas está desativada neste perfil.',
    ].join('\n');
  }
  return [
    `You have read-only access to the SAP system "${profile.name}" (${profile.environment}, client ${profile.client}) through the MCP server "${server}".`,
    '',
    'Available tools:',
    list,
    '',
    'How to use them:',
    '- Before reading an object by name, confirm its name and type with SearchObject (use * as wildcard, e.g. Z*SALES*).',
    '- Read large sources in parts with startLine and maxLines (e.g. maxLines 400). The answer includes totalLines and hasMore; continue at startLine + returnedLines while hasMore is true.',
    '- GetFunction needs both the function module name and its function group.',
    '- When answering, cite the object and lines each excerpt comes from.',
    '',
    'Care:',
    `- This is a ${profile.environment} system; nothing is changed, but treat its content as confidential.`,
    tableData
      ? '- GetTableContents reads business data: use it only when I ask, with few rows (max_rows), and do not reproduce personal data.'
      : '- Reading table contents is disabled for this profile.',
  ].join('\n');
}
