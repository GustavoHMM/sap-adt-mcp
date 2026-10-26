import fs from 'node:fs';
import path from 'node:path';
import { appHome } from './paths.ts';

/** App-wide preferences shared by the app and the CLI (never secrets). */
export interface Settings {
  /** Manual language choice; absent means "follow Windows". */
  language?: 'pt' | 'en';
}

const settingsFile = () => path.join(appHome(), 'settings.json');

export function loadSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(appHome(), { recursive: true });
  const tmp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, settingsFile());
}
