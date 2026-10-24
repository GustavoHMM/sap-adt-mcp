import { loadKoffi } from '../native.ts';

/** Per-user proxy settings as shown in Windows Settings > Network > Proxy. */
export interface IeProxyConfig {
  autoDetect: boolean;
  pacUrl: string | null;
  proxy: string | null;
  bypass: string | null;
}

export type AutoProxyResult =
  | { ok: true; proxy: string | null; bypass: string | null }
  | { ok: false; error: number };

export const WINHTTP_ERRORS: Record<number, string> = {
  12167: 'pac-download-failed',
  12166: 'pac-script-error',
  12178: 'autoproxy-service-error',
  12180: 'wpad-not-found',
  12015: 'pac-login-failed',
};

const WINHTTP_ACCESS_TYPE_NO_PROXY = 1;
const WINHTTP_ACCESS_TYPE_NAMED_PROXY = 3;
const WINHTTP_AUTOPROXY_AUTO_DETECT = 1;
const WINHTTP_AUTOPROXY_CONFIG_URL = 2;
const WINHTTP_AUTO_DETECT_TYPE_DHCP = 1;
const WINHTTP_AUTO_DETECT_TYPE_DNS_A = 2;

function createApi() {
  const koffi = loadKoffi();
  const winhttp = koffi.load('winhttp.dll');
  const kernel32 = koffi.load('kernel32.dll');
  koffi.struct('WINHTTP_CURRENT_USER_IE_PROXY_CONFIG', {
    fAutoDetect: 'int',
    lpszAutoConfigUrl: 'void *',
    lpszProxy: 'void *',
    lpszProxyBypass: 'void *',
  });
  koffi.struct('WINHTTP_AUTOPROXY_OPTIONS', {
    dwFlags: 'uint32',
    dwAutoDetectFlags: 'uint32',
    lpszAutoConfigUrl: 'str16',
    lpvReserved: 'void *',
    dwReserved: 'uint32',
    fAutoLogonIfChallenged: 'int',
  });
  koffi.struct('WINHTTP_PROXY_INFO', { dwAccessType: 'uint32', lpszProxy: 'void *', lpszProxyBypass: 'void *' });
  const globalFree = kernel32.func('void * __stdcall GlobalFree(void *p)');
  return {
    koffi,
    getIeConfig: winhttp.func(
      'bool __stdcall WinHttpGetIEProxyConfigForCurrentUser(_Out_ WINHTTP_CURRENT_USER_IE_PROXY_CONFIG *cfg)',
    ),
    open: winhttp.func('void * __stdcall WinHttpOpen(str16 agent, uint32 access, str16 proxy, str16 bypass, uint32 flags)'),
    close: winhttp.func('bool __stdcall WinHttpCloseHandle(void *h)'),
    setTimeouts: winhttp.func('bool __stdcall WinHttpSetTimeouts(void *h, int resolve, int connect, int send, int receive)'),
    getProxyForUrl: winhttp.func(
      'bool __stdcall WinHttpGetProxyForUrl(void *h, str16 url, WINHTTP_AUTOPROXY_OPTIONS *opt, _Out_ WINHTTP_PROXY_INFO *info)',
    ),
    getLastError: kernel32.func('uint32 __stdcall GetLastError()'),
    /** Reads a WinHTTP-allocated UTF-16 string and frees it. */
    takeString(ptr: unknown): string | null {
      if (!ptr) return null;
      const value = koffi.decode.string16(ptr as bigint);
      globalFree(ptr);
      return value;
    },
  };
}

let api: ReturnType<typeof createApi> | undefined;
const winApi = () => (api ??= createApi());

export function getIeProxyConfig(): IeProxyConfig | null {
  const w = winApi();
  const cfg: Record<string, unknown> = {};
  if (!w.getIeConfig(cfg)) return null;
  return {
    autoDetect: Boolean(cfg.fAutoDetect),
    pacUrl: w.takeString(cfg.lpszAutoConfigUrl),
    proxy: w.takeString(cfg.lpszProxy),
    bypass: w.takeString(cfg.lpszProxyBypass),
  };
}

/**
 * Lets Windows itself evaluate the PAC script and/or WPAD discovery for a URL.
 * Synchronous on purpose: it runs once at startup, and only the synchronous
 * call reports GetLastError reliably.
 */
export function getProxyForUrl(
  url: string,
  options: { autoDetect: boolean; pacUrl?: string | null; timeoutMs?: number },
): AutoProxyResult {
  const w = winApi();
  const session = w.open('abap-adt-mcp', WINHTTP_ACCESS_TYPE_NO_PROXY, null, null, 0);
  if (!session) return { ok: false, error: w.getLastError() };
  try {
    const t = options.timeoutMs ?? 10_000;
    w.setTimeouts(session, t, t, t, t);
    const flags =
      (options.autoDetect ? WINHTTP_AUTOPROXY_AUTO_DETECT : 0) | (options.pacUrl ? WINHTTP_AUTOPROXY_CONFIG_URL : 0);
    const info: Record<string, unknown> = {};
    const ok = w.getProxyForUrl(
      session,
      url,
      {
        dwFlags: flags,
        dwAutoDetectFlags: options.autoDetect ? WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A : 0,
        lpszAutoConfigUrl: options.pacUrl ?? null,
        lpvReserved: null,
        dwReserved: 0,
        fAutoLogonIfChallenged: 1,
      },
      info,
    );
    if (!ok) return { ok: false, error: w.getLastError() };
    const proxy = w.takeString(info.lpszProxy);
    const bypass = w.takeString(info.lpszProxyBypass);
    return { ok: true, proxy: info.dwAccessType === WINHTTP_ACCESS_TYPE_NAMED_PROXY ? proxy : null, bypass };
  } finally {
    w.close(session);
  }
}
