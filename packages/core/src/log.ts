import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from './paths.ts';

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

/** Last line of defence: logs must never carry secrets even if a caller slips. */
export function redact(text: string): string {
  return text
    .replace(/(authorization["']?\s*[:=]\s*["']?)(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1$2 [redacted]')
    .replace(/(x-csrf-token["']?\s*[:=]\s*["']?)(?!fetch\b)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/(cookie["']?\s*[:=]\s*["']?)[^"'\n]+/gi, '$1[redacted]')
    .replace(/(SAP_PASSWORD["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/(MYSAPSSO2|SAP_SESSIONID_[A-Z0-9_]+)=[^;\s"']+/gi, '$1=[redacted]');
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** JSON-lines log with size-based rotation (name.log, name.1.log, ...). Never throws. */
export function createLogger(name: string): Logger {
  const dir = logsDir();
  const file = path.join(dir, `${name}.log`);
  const write = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotate(file);
      const line = redact(JSON.stringify({ time: new Date().toISOString(), level, event, pid: process.pid, ...fields }));
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      // Logging must never break the MCP stream.
    }
  };
  return {
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
  };
}

function rotate(file: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;
  const base = file.slice(0, -'.log'.length);
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${base}.${i - 1}.log`;
    try {
      fs.renameSync(from, `${base}.${i}.log`);
    } catch {
      // Missing older generations are fine.
    }
  }
}
