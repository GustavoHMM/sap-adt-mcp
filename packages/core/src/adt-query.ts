import http from 'node:http';
import https from 'node:https';
import { trustedCas } from './certs.ts';
import type { Profile } from './profiles.ts';
import { APP_VERSION } from './version.ts';

export interface QueryColumn {
  name: string;
  description: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  /** One array per row, in column order. */
  rows: string[][];
  /** Rows matching the query according to SAP, when it says so. */
  totalRows?: number;
}

export type QueryErrorKind = 'sql' | 'auth' | 'forbidden' | 'connection' | 'http' | 'too-large';

export class AdtQueryError extends Error {
  readonly kind: QueryErrorKind;
  readonly status?: number;
  constructor(kind: QueryErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface AdtConnection {
  profile: Profile;
  password: string;
  proxyUrl: string | null;
  timeoutMs?: number;
}

/** Same ceiling as the upstream's responses. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Runs ABAP SQL SELECTs through the ADT data preview, the endpoint behind the
 * SQL Console in Eclipse (/sap/bc/adt/datapreview/freestyle). The upstream
 * uses the same endpoint for GetTableContents, but always with SELECT * and a
 * one-line XML answer that its 40 KB cap cuts; the launcher sends the real
 * query and returns a compact table instead. Read-only: the endpoint runs
 * SELECTs only.
 */
export class AdtQueryClient {
  private readonly conn: AdtConnection;
  private readonly agent: http.Agent;
  private readonly secure: boolean;
  private readonly cookies = new Map<string, string>();
  private csrf?: string;

  constructor(conn: AdtConnection) {
    this.conn = conn;
    this.secure = new URL(conn.profile.url).protocol === 'https:';
    const proxyEnv = conn.proxyUrl ? { HTTPS_PROXY: conn.proxyUrl, HTTP_PROXY: conn.proxyUrl, NO_PROXY: '' } : undefined;
    this.agent = this.secure
      ? new https.Agent({ ca: trustedCas(conn.profile), keepAlive: true, ...(proxyEnv ? { proxyEnv } : {}) })
      : new http.Agent({ keepAlive: true, ...(proxyEnv ? { proxyEnv } : {}) });
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    for (let attempt = 0; ; attempt++) {
      if (!this.csrf) await this.fetchToken();
      const res = await this.send('POST', '/sap/bc/adt/datapreview/freestyle', { rowNumber: String(maxRows) }, {
        'content-type': 'text/plain',
        accept: 'application/xml, text/plain, */*',
        'x-csrf-token': this.csrf!,
      }, sql);
      // An expired session asks for a new token once.
      if (res.status === 403 && String(res.headers['x-csrf-token'] ?? '').toLowerCase() === 'required' && attempt === 0) {
        this.csrf = undefined;
        continue;
      }
      if (res.status >= 200 && res.status < 300) return parseTableData(res.body);
      throw errorFor(res);
    }
  }

  close(): void {
    this.agent.destroy();
  }

  private async fetchToken(): Promise<void> {
    const res = await this.send('GET', '/sap/bc/adt/discovery', {}, { 'x-csrf-token': 'fetch', accept: 'application/atomsvc+xml' });
    if (res.status < 200 || res.status >= 300) throw errorFor(res);
    const token = res.headers['x-csrf-token'];
    if (typeof token !== 'string' || !token || token.toLowerCase() === 'required') {
      throw new AdtQueryError('http', 'SAP did not return a CSRF token', res.status);
    }
    this.csrf = token;
  }

  private send(method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body?: string): Promise<RawResponse> {
    const { profile, password } = this.conn;
    const target = new URL(path, profile.url);
    target.searchParams.set('sap-client', profile.client);
    if (profile.language) target.searchParams.set('sap-language', profile.language.toUpperCase());
    for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
    const all: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${profile.username}:${password}`).toString('base64')}`,
      'user-agent': `abap-adt-mcp/${APP_VERSION}`,
      ...headers,
    };
    if (this.cookies.size) all.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const timeout = this.conn.timeoutMs ?? 60_000;

    return new Promise<RawResponse>((resolve, reject) => {
      const req = (this.secure ? https : http).request(target, { method, agent: this.agent, timeout, headers: all });
      req.once('timeout', () => req.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
      req.once('error', (e) => reject(new AdtQueryError('connection', (e as { code?: string }).code ?? e.message)));
      req.once('response', (res) => {
        for (const c of res.headers['set-cookie'] ?? []) {
          const [pair] = c.split(';');
          const eq = pair!.indexOf('=');
          if (eq > 0) this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new AdtQueryError('too-large', `more than ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.once('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.once('error', (e) => reject(new AdtQueryError('connection', e.message)));
      });
      req.end(body);
    });
  }
}

function errorFor(res: RawResponse): AdtQueryError {
  if (res.status === 401) return new AdtQueryError('auth', 'HTTP 401', 401);
  const message = exceptionMessage(res.body);
  if (res.status === 403 && !message) return new AdtQueryError('forbidden', 'HTTP 403', 403);
  // SAP explains rejected queries (unknown column, syntax, missing authorization) in an exception document.
  if (message) return new AdtQueryError(res.status === 403 ? 'forbidden' : 'sql', message, res.status);
  return new AdtQueryError('http', `HTTP ${res.status}`, res.status);
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The text of an ADT exception document (localized first), or undefined. */
export function exceptionMessage(xml: string): string | undefined {
  if (!/<(?:[\w-]+:)?exception\b/.test(xml)) return undefined;
  const pick = (tag: string) => new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`).exec(xml)?.[1]?.trim();
  const text = pick('localizedMessage') || pick('message');
  return text ? decodeXml(text) : undefined;
}

/**
 * Reads the data preview answer. SAP sends it by column: each <columns> holds
 * the column's <metadata> and a <dataSet> with one <data> per row.
 */
export function parseTableData(xml: string): QueryResult {
  const columns: QueryColumn[] = [];
  const values: string[][] = [];
  const block = /<((?:[\w-]+:)?)columns\b[^>]*>([\s\S]*?)<\/\1columns>/g;
  for (let m = block.exec(xml); m; m = block.exec(xml)) {
    const inner = m[2]!;
    const meta = /<(?:[\w-]+:)?metadata\b([^>]*?)\/?>/.exec(inner)?.[1] ?? '';
    const attrs = new Map<string, string>();
    for (const a of meta.matchAll(/(?:[\w-]+:)?([\w-]+)="([^"]*)"/g)) attrs.set(a[1]!, decodeXml(a[2]!));
    columns.push({ name: attrs.get('name') ?? `COL${columns.length + 1}`, description: attrs.get('description') ?? '' });
    const data: string[] = [];
    for (const d of inner.matchAll(/<(?:[\w-]+:)?data\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?data>)/g)) data.push(decodeXml(d[1] ?? ''));
    values.push(data);
  }
  const count = Math.max(0, ...values.map((v) => v.length));
  const rows = Array.from({ length: count }, (_, r) => values.map((v) => v[r] ?? ''));
  const total = /<(?:[\w-]+:)?totalRows>\s*(\d+)\s*</.exec(xml)?.[1];
  return { columns, rows, totalRows: total === undefined ? undefined : Number(total) };
}
