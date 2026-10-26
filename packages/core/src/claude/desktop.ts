import fs from 'node:fs';
import path from 'node:path';

export interface DesktopInstall {
  kind: 'msix' | 'squirrel';
  /** MSIX package family name, e.g. Claude_pzs8sxrjxfjjc. */
  packageFamilyName?: string;
  /** The config file Claude Desktop really reads, or null when it cannot be known yet. */
  configPath: string | null;
  /** How to start Claude Desktop again. */
  launch: { command: string; args: string[] };
  /** Recognizes this installation's processes by their executable path. */
  exePattern: RegExp;
}

const CONFIG_FILE = 'claude_desktop_config.json';

/** A ".user-data-left.*" file means Claude moved its data away from this folder. */
function isAbandoned(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((n) => n.startsWith('.user-data-left'));
  } catch {
    return false;
  }
}

function findDirIgnoringCase(parent: string, name: string): string | undefined {
  try {
    const hit = fs.readdirSync(parent).find((n) => n.toLowerCase() === name.toLowerCase());
    return hit ? path.join(parent, hit) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds Claude Desktop and the config file it actually reads. MSIX installs
 * (Store/enterprise) virtualize AppData, and recent versions keep data in
 * %LOCALAPPDATA%\Claude-Data\<family name>; older ones in the package LocalCache.
 * The classic installer uses %APPDATA%\Claude.
 */
export function detectClaudeDesktop(env: NodeJS.ProcessEnv = process.env): DesktopInstall | null {
  const local = env.LOCALAPPDATA ?? '';
  const roaming = env.APPDATA ?? '';

  // MSIX: Windows removes Packages\<family> on uninstall, so it marks a live install.
  let families: string[] = [];
  try {
    families = fs.readdirSync(path.join(local, 'Packages')).filter((n) => /^Claude_[a-z0-9]+$/i.test(n));
  } catch {
    families = [];
  }
  const family = families[0];
  if (family) {
    let configPath: string | null = null;
    const dataDir = findDirIgnoringCase(path.join(local, 'Claude-Data'), family);
    const cacheDir = path.join(local, 'Packages', family, 'LocalCache', 'Roaming', 'Claude');
    if (dataDir && !isAbandoned(dataDir)) configPath = path.join(dataDir, CONFIG_FILE);
    else if (fs.existsSync(cacheDir) && !isAbandoned(cacheDir)) configPath = path.join(cacheDir, CONFIG_FILE);
    return {
      kind: 'msix',
      packageFamilyName: family,
      configPath,
      launch: { command: path.join(env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), args: [`shell:AppsFolder\\${family}!Claude`] },
      // Install folder: WindowsApps\<name>_<version>_<arch>__<publisher id>; the publisher id ties it to this package.
      exePattern: new RegExp(`\\\\WindowsApps\\\\Claude_[^\\\\]+__${family.split('_')[1]}\\\\app\\\\claude\\.exe$`, 'i'),
    };
  }

  const stub = path.join(local, 'AnthropicClaude', 'claude.exe');
  if (fs.existsSync(stub)) {
    const dir = path.join(roaming, 'Claude');
    return {
      kind: 'squirrel',
      configPath: isAbandoned(dir) ? null : path.join(dir, CONFIG_FILE),
      launch: { command: stub, args: [] },
      exePattern: /\\AnthropicClaude\\app-[^\\]+\\claude\.exe$/i,
    };
  }
  return null;
}
