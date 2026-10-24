export type UrlNote =
  | { code: 'scheme-added' }
  | { code: 'credentials-removed' }
  | { code: 'path-removed'; value: string }
  | { code: 'query-removed' }
  | { code: 'client-detected'; value: string }
  | { code: 'insecure-http' };

export interface NormalizedUrl {
  /** Protocol, host and port only, as the upstream requires (SAP_URL). */
  origin: string;
  changed: boolean;
  notes: UrlNote[];
  /** Client found in a pasted URL (sap-client=400), offered as a suggestion. */
  client?: string;
}

export class UrlError extends Error {
  readonly code: 'empty' | 'invalid' | 'unsupported-scheme';
  constructor(code: 'empty' | 'invalid' | 'unsupported-scheme') {
    super(code);
    this.code = code;
  }
}

/**
 * Accepts what people paste (browser address, Eclipse ADT link, host:port) and
 * reduces it to the SAP origin, recording every change so the UI can explain it.
 */
export function normalizeSapUrl(input: string): NormalizedUrl {
  const raw = input.trim();
  if (!raw) throw new UrlError('empty');
  const notes: UrlNote[] = [];

  let text = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `https://${text}`;
    notes.push({ code: 'scheme-added' });
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UrlError('invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UrlError('unsupported-scheme');
  if (!url.hostname) throw new UrlError('invalid');

  if (url.username || url.password) notes.push({ code: 'credentials-removed' });
  const client = url.searchParams.get('sap-client') ?? undefined;
  if (client && /^\d{3}$/.test(client)) notes.push({ code: 'client-detected', value: client });
  if (url.search) notes.push({ code: 'query-removed' });
  if (url.pathname && url.pathname !== '/') notes.push({ code: 'path-removed', value: decodeURIComponent(url.pathname) });
  if (url.protocol === 'http:') notes.push({ code: 'insecure-http' });

  const origin = url.origin;
  const changed = notes.some((n) => n.code !== 'insecure-http' && n.code !== 'client-detected') || origin !== raw;
  return { origin, changed, notes, client: client && /^\d{3}$/.test(client) ? client : undefined };
}
