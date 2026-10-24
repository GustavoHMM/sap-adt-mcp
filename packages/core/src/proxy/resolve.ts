import type { ProxySetting } from '../profiles.ts';
import { bypassesProxy, pickProxy } from './parse.ts';
import { getIeProxyConfig, getProxyForUrl, WINHTTP_ERRORS } from './winhttp.ts';

export type ProxySource = 'profile-direct' | 'profile-manual' | 'profile-pac' | 'system-pac' | 'system-wpad' | 'system-static' | 'system-none';

export interface ProxyDecision {
  /** http(s)://host:port of the proxy, or null to connect directly. */
  proxyUrl: string | null;
  source: ProxySource;
  /** Why automatic configuration was skipped, e.g. "pac-download-failed". */
  warning?: string;
}

/** Decides how to reach the SAP origin, following the profile and then Windows settings. */
export function resolveProxy(sapUrl: string, setting: ProxySetting = { mode: 'system' }): ProxyDecision {
  const target = new URL(sapUrl);
  const scheme = target.protocol === 'http:' ? 'http' : 'https';
  switch (setting.mode) {
    case 'direct':
      return { proxyUrl: null, source: 'profile-direct' };
    case 'manual':
      return { proxyUrl: pickProxy(setting.url, scheme), source: 'profile-manual' };
    case 'pac': {
      const r = getProxyForUrl(target.href, { autoDetect: false, pacUrl: setting.url });
      if (r.ok) return { proxyUrl: pickProxy(r.proxy, scheme), source: 'profile-pac' };
      return { proxyUrl: null, source: 'profile-pac', warning: WINHTTP_ERRORS[r.error] ?? `winhttp-${r.error}` };
    }
    case 'system':
      break;
  }

  const ie = getIeProxyConfig();
  if (!ie) return { proxyUrl: null, source: 'system-none', warning: 'ie-config-unavailable' };

  let warning: string | undefined;
  if (ie.autoDetect || ie.pacUrl) {
    const r = getProxyForUrl(target.href, { autoDetect: ie.autoDetect, pacUrl: ie.pacUrl });
    if (r.ok) return { proxyUrl: pickProxy(r.proxy, scheme), source: ie.pacUrl ? 'system-pac' : 'system-wpad' };
    // No WPAD on the network is the normal case at home; it is not worth a warning.
    if (!(r.error === 12180 && !ie.pacUrl)) warning = WINHTTP_ERRORS[r.error] ?? `winhttp-${r.error}`;
  }

  if (ie.proxy && !bypassesProxy(target.hostname, ie.bypass)) {
    const proxyUrl = pickProxy(ie.proxy, scheme);
    if (proxyUrl) return { proxyUrl, source: 'system-static', warning };
  }
  return { proxyUrl: null, source: 'system-none', warning };
}
