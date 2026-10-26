import fs from 'node:fs';
import path from 'node:path';
import { removeOwnedEntries } from '@abap-adt-mcp/core/claude/integration';
import { listProcesses } from '@abap-adt-mcp/core/claude/processes';
import { deletePassword } from '@abap-adt-mcp/core/credentials';
import { createLogger } from '@abap-adt-mcp/core/log';
import { exeDir } from '@abap-adt-mcp/core/native';
import { appHome } from '@abap-adt-mcp/core/paths';
import { loadProfiles } from '@abap-adt-mcp/core/profiles';
import { isOurExecutable, removeRuntime } from '@abap-adt-mcp/core/runtime';
import { loadSettings, saveSettings } from '@abap-adt-mcp/core/settings';

function inUse(dir: string): boolean {
  const prefix = path.resolve(dir).toLowerCase() + path.sep;
  try {
    return listProcesses().some((p) => p.pid !== process.pid && p.path?.toLowerCase().startsWith(prefix));
  } catch {
    return true;
  }
}

/**
 * Called by the uninstaller (not on updates). Removes from Claude only the
 * entries that run this installation's executables (a developer's hand-made
 * registration elsewhere stays), deletes the runtime copies, and with
 * --purge also profiles, passwords and all app data.
 */
export async function uninstallCleanup(purge: boolean): Promise<void> {
  const log = createLogger('uninstall');
  // <install>\resources\cli\abap-adt-mcp.exe → <install>
  const installRoot = path.resolve(exeDir, '..', '..');
  const removed = await removeOwnedEntries((cmd) => isOurExecutable(cmd, [installRoot]));
  const settings = loadSettings();
  delete settings.claude;
  saveSettings(settings);
  removeRuntime(inUse);
  log.info('cleanup', { removedClaudeEntries: removed, purge });

  if (!purge) return;
  for (const p of loadProfiles()) {
    try {
      deletePassword(p.id);
    } catch {
      // never saved
    }
  }
  for (const name of fs.readdirSync(appHome())) {
    if (name === 'runtime') continue;
    fs.rmSync(path.join(appHome(), name), { recursive: true, force: true });
  }
}
