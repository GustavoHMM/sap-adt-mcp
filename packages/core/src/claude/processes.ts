import { loadKoffi } from '../native.ts';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Full executable path, when Windows lets us read it. */
  path: string | null;
}

function createApi() {
  const koffi = loadKoffi();
  const kernel32 = koffi.load('kernel32.dll');
  koffi.struct('PROCESSENTRY32W', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ProcessID: 'uint32',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32',
    cntThreads: 'uint32',
    th32ParentProcessID: 'uint32',
    pcPriClassBase: 'int32',
    dwFlags: 'uint32',
    szExeFile: koffi.array('char16_t', 260, 'String'),
  });
  return {
    koffi,
    snapshot: kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
    first: kernel32.func('bool __stdcall Process32FirstW(void *snap, _Inout_ PROCESSENTRY32W *entry)'),
    next: kernel32.func('bool __stdcall Process32NextW(void *snap, _Inout_ PROCESSENTRY32W *entry)'),
    open: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    close: kernel32.func('bool __stdcall CloseHandle(void *h)'),
    imageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ char16_t *buf, _Inout_ uint32 *size)'),
  };
}

let api: ReturnType<typeof createApi> | undefined;
const INVALID_HANDLE = -1n;
const TH32CS_SNAPPROCESS = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** Lists running processes with their executable paths (Toolhelp + QueryFullProcessImageName). */
export function listProcesses(): ProcessInfo[] {
  api ??= createApi();
  const a = api;
  const snap = a.snapshot(TH32CS_SNAPPROCESS, 0) as bigint | null;
  if (!snap || BigInt.asIntN(64, BigInt(snap)) === INVALID_HANDLE) return [];
  const out: ProcessInfo[] = [];
  try {
    const entry: Record<string, unknown> = { dwSize: a.koffi.sizeof('PROCESSENTRY32W') };
    let ok = a.first(snap, entry);
    while (ok) {
      const pid = entry.th32ProcessID as number;
      let exe: string | null = null;
      const h = pid ? a.open(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) : null;
      if (h) {
        const buf = Buffer.alloc(32768 * 2);
        const size = [32768];
        if (a.imageName(h, 0, buf, size)) exe = buf.toString('utf16le', 0, (size[0] ?? 0) * 2);
        a.close(h);
      }
      out.push({ pid, ppid: entry.th32ParentProcessID as number, path: exe });
      ok = a.next(snap, entry);
    }
  } finally {
    a.close(snap);
  }
  return out;
}
