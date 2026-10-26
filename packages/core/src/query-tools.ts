import { AdtQueryError, type QueryResult } from './adt-query.ts';
import { t, type Lang, type MessageKey } from './messages.ts';

/** A tool the launcher answers itself instead of the upstream. */
export interface LocalTool {
  definition: { name: string; description: string; inputSchema: Record<string, unknown> };
  call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean; httpStatus?: number }>;
}

export interface QueryRunner {
  query(sql: string, maxRows: number): Promise<QueryResult>;
}

/** Same budget the upstream uses for one tool answer. */
export const QUERY_OUTPUT_BYTES = 40_000;
const MAX_ROWS = 10_000;
const DEFAULT_ROWS = 100;
/** Column descriptions are listed while they stay readable. */
const DESCRIBED_COLUMNS = 40;

const MAX_ROWS_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_ROWS,
  default: DEFAULT_ROWS,
  description: 'Maximum rows SAP returns. Keep it small; sort with order_by to choose which rows come.',
};

const GET_TABLE_CONTENTS = {
  name: 'GetTableContents',
  description:
    'Read rows of an ABAP table, view or CDS entity (read-only data preview, like SE16). Name only the columns you need, filter with an ABAP SQL condition and sort with order_by. The answer is a tab-separated table.',
  inputSchema: {
    type: 'object',
    properties: {
      table_name: { type: 'string', description: 'Table, view or CDS entity, e.g. MARA' },
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Columns to return, e.g. ["MATNR", "ERSDA", "ERNAM"]. Omit for all columns; wide tables then get cut, so prefer naming them.',
      },
      where: { type: 'string', description: "ABAP SQL condition without WHERE, e.g. ERSDA >= '20240101' AND MTART = 'FERT'" },
      order_by: { type: 'string', description: 'ABAP SQL sort without ORDER BY, e.g. ERSDA DESCENDING, MATNR' },
      max_rows: MAX_ROWS_SCHEMA,
    },
    required: ['table_name'],
  },
};

const RUN_SQL_QUERY = {
  name: 'RunSqlQuery',
  description:
    'Run one read-only ABAP SQL SELECT, as in the SQL Console of ADT in Eclipse: joins, CDS views, WHERE, GROUP BY, aggregates and ORDER BY. No INTO and no final period; limit rows with max_rows. The answer is a tab-separated table.',
  inputSchema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'e.g. SELECT matnr, ersda, ernam FROM mara ORDER BY ersda DESCENDING, created_at_time DESCENDING',
      },
      max_rows: MAX_ROWS_SCHEMA,
    },
    required: ['sql'],
  },
};

class InvalidArgs extends Error {
  readonly key: MessageKey;
  constructor(key: MessageKey) {
    super(key);
    this.key = key;
  }
}

const TABLE = /^[A-Z0-9_/]+$/;
const COLUMN = /^[A-Za-z0-9_/~]+$/;

function maxRowsOf(args: Record<string, unknown>): number {
  const v = args.max_rows ?? DEFAULT_ROWS;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_ROWS) throw new InvalidArgs('query.invalid.maxRows');
  return v;
}

/** One SELECT, nothing chained: the endpoint only runs queries, this keeps it to exactly one. */
export function checkSelect(sql: string): string {
  const text = sql.trim().replace(/[.\s]+$/, '');
  if (!/^(SELECT|WITH)\b/i.test(text)) throw new InvalidArgs('query.invalid.select');
  if (text.includes(';')) throw new InvalidArgs('query.invalid.semicolon');
  return text;
}

export function tableQuery(args: Record<string, unknown>): string {
  const table = typeof args.table_name === 'string' ? args.table_name.trim().toUpperCase() : '';
  if (!TABLE.test(table)) throw new InvalidArgs('query.invalid.table');
  let columns = '*';
  if (args.columns !== undefined) {
    const list = Array.isArray(args.columns) ? args.columns : [];
    if (!list.length || !list.every((c) => typeof c === 'string' && COLUMN.test(c.trim()))) throw new InvalidArgs('query.invalid.columns');
    columns = list.map((c) => (c as string).trim().toUpperCase()).join(', ');
  }
  let sql = `SELECT ${columns} FROM ${table}`;
  const where = typeof args.where === 'string' ? args.where.trim() : '';
  const order = typeof args.order_by === 'string' ? args.order_by.trim() : '';
  if (where) sql += ` WHERE ${where}`;
  if (order) sql += ` ORDER BY ${order}`;
  return checkSelect(sql);
}

const cell = (v: string) => v.replace(/[\t\r\n]+/g, ' ').trimEnd();
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** A compact, tab-separated answer that always fits the budget, cutting whole rows. */
export function formatResult(result: QueryResult, maxRows: number, lang: Lang, budget = QUERY_OUTPUT_BYTES): string {
  const n = (v: number) => v.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US');
  const head: string[] = [];
  const total = result.totalRows;
  head.push(
    total !== undefined && total >= result.rows.length
      ? t(lang, 'query.rowsOfTotal', { rows: n(result.rows.length), total: n(total) })
      : t(lang, 'query.rows', { rows: n(result.rows.length) }),
  );
  if (result.rows.length >= maxRows && (total === undefined || total > maxRows)) head.push(t(lang, 'query.limited', { max: maxRows }));
  if (!result.rows.length) return head.join('\n');
  if (result.columns.length <= DESCRIBED_COLUMNS && result.columns.some((c) => c.description)) {
    head.push(t(lang, 'query.columns', { list: result.columns.map((c) => (c.description ? `${c.name} (${c.description})` : c.name)).join(', ') }));
  }
  head.push('');
  const header = result.columns.map((c) => c.name).join('\t');
  // Room for the note added when rows have to go.
  const reserve = 400;
  let used = bytes(head.join('\n')) + bytes(header) + 2;
  const lines = [header];
  let shown = 0;
  for (const row of result.rows) {
    const line = row.map(cell).join('\t');
    if (used + bytes(line) + 1 > budget - reserve) break;
    lines.push(line);
    used += bytes(line) + 1;
    shown++;
  }
  if (shown === 0) {
    // Not even one row fits: the columns themselves are too many.
    return [...head.slice(0, -1), t(lang, 'query.tooWide', { columns: result.columns.length, kb: Math.round(budget / 1000) })].join('\n');
  }
  const text = [...head, ...lines].join('\n');
  if (shown === result.rows.length) return text;
  return `${text}\n\n${t(lang, 'query.cut', { shown: n(shown), rows: n(result.rows.length), kb: Math.round(budget / 1000) })}`;
}

function errorText(e: unknown, lang: Lang, profileId: string): { text: string; httpStatus?: number } {
  if (e instanceof InvalidArgs) return { text: t(lang, e.key) };
  if (e instanceof AdtQueryError) {
    const vars = { profile: profileId, message: e.message, status: e.status ?? '' };
    switch (e.kind) {
      case 'sql':
        return { text: t(lang, 'query.sqlError', vars), httpStatus: e.status };
      case 'auth':
        return { text: t(lang, 'relay.http401', vars), httpStatus: 401 };
      case 'forbidden':
        return { text: t(lang, 'query.forbidden', vars), httpStatus: 403 };
      case 'connection':
        return { text: t(lang, 'relay.connection', vars) };
      case 'too-large':
        return { text: t(lang, 'query.tooLarge') };
      default:
        return { text: t(lang, e.status && e.status >= 500 ? 'relay.http5xx' : 'query.httpError', vars), httpStatus: e.status };
    }
  }
  return { text: (e as Error)?.message ?? String(e) };
}

/**
 * GetTableContents (replacing the upstream's SELECT * version) and RunSqlQuery.
 * Without a runner (no password, blocked profile) every call explains why.
 */
export function createQueryTools(runner: QueryRunner | null, lang: Lang, profileId: string, unavailable: string): LocalTool[] {
  const run = async (sql: () => string, args: Record<string, unknown>) => {
    try {
      const maxRows = maxRowsOf(args);
      const query = sql();
      if (!runner) return { text: `Error: ${unavailable}`, isError: true };
      return { text: formatResult(await runner.query(query, maxRows), maxRows, lang), isError: false };
    } catch (e) {
      const { text, httpStatus } = errorText(e, lang, profileId);
      return { text: `Error: ${text}`, isError: true, httpStatus };
    }
  };
  return [
    { definition: GET_TABLE_CONTENTS, call: (args) => run(() => tableQuery(args), args) },
    { definition: RUN_SQL_QUERY, call: (args) => run(() => checkSelect(typeof args.sql === 'string' ? args.sql : ''), args) },
  ];
}
