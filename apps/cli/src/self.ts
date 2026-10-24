import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

/** How to start this same CLI again (the connection test launches "serve" like Claude does). */
export function selfCommand(): { command: string; args: string[] } {
  if (isSea()) return { command: process.execPath, args: [] };
  return { command: process.execPath, args: [fileURLToPath(new URL('./main.ts', import.meta.url))] };
}

/** The exe (or dev command) that Claude configs must point to. */
export function serveCommandFor(profileId: string): { command: string; args: string[] } {
  const self = selfCommand();
  return { command: self.command, args: [...self.args, 'serve', '--profile', profileId] };
}
