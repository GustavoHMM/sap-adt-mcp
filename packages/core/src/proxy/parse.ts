/**
 * Picks the proxy that Windows would use for a scheme from a WinINet/WinHTTP
 * list such as "host:8080", "http=a:80;https=b:443" or "a:80;b:80" (first wins).
 * Returns null when no usable proxy applies (SOCKS is not supported).
 */
export function pickProxy(list: string | null | undefined, scheme: 'http' | 'https'): string | null {
  if (!list) return null;
  let generic: string | null = null;
  for (const entry of list.split(/[;\s]+/).filter(Boolean)) {
    const typed = /^([a-z]+)=(.+)$/i.exec(entry);
    if (typed) {
      if (typed[1]!.toLowerCase() === scheme) return toProxyUrl(typed[2]!);
      continue;
    }
    generic ??= toProxyUrl(entry);
  }
  return generic;
}

function toProxyUrl(value: string): string | null {
  let v = value.trim();
  if (/^socks/i.test(v)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * Applies the Windows "do not use proxy for" list. "<local>" means names without
 * a dot; entries may use * wildcards and an optional scheme or port. Loopback is
 * always bypassed, as Windows does.
 */
export function bypassesProxy(host: string, bypassList: string | null | undefined): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopback(h)) return true;
  if (!bypassList) return false;
  for (const raw of bypassList.split(/[;,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '<local>') {
      if (!h.includes('.') && !h.includes(':')) return true;
      continue;
    }
    const pattern = entry.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '');
    const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    if (re.test(h)) return true;
  }
  return false;
}
