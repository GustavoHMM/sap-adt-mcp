import { execFileSync } from 'node:child_process';

/** Runs npm without shell:true (deprecated with arguments); on Windows npm is a .cmd that needs cmd.exe. */
export function npm(args, options = {}) {
  if (process.platform !== 'win32') return execFileSync('npm', args, options);
  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')], options);
}
