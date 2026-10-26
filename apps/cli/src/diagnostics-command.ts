import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { buildDiagnostics, defaultDiagnosticsPath } from '@abap-adt-mcp/core/diagnostics';
import { t, type Lang } from '@abap-adt-mcp/core/messages';
import { stableExe } from '@abap-adt-mcp/core/runtime';
import { selfCommand } from './self.ts';

/** "diagnostics": writes the support .zip (no passwords, cookies, CSRF tokens or user names). */
export async function writeDiagnostics(lang: Lang, out: string | undefined, network: boolean): Promise<string> {
  const file = path.resolve(out ?? defaultDiagnosticsPath());
  // Installed copies are registered in Claude through the stable runtime path.
  const server = isSea() ? { command: stableExe(), args: [] } : selfCommand();
  const zip = await buildDiagnostics({ lang, server, network });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zip);
  process.stdout.write(t(lang, 'cli.diagnosticsSaved', { file }) + '\n');
  return file;
}
