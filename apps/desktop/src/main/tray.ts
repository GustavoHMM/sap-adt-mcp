import { Menu, Tray, nativeImage } from 'electron';
import { t, type Lang } from '@abap-adt-mcp/core/messages';
import { loadProfiles } from '@abap-adt-mcp/core/profiles';
import type { NavigateTarget } from '../shared/api.ts';

export interface TrayActions {
  iconPath: string;
  show: (target?: NavigateTarget) => void;
  quit: () => void;
  lang: () => Lang;
}

/** Quick access near the clock: open the app, test a profile, see Claude connections, quit. */
export function createTray(actions: TrayActions): { tray: Tray; refresh: () => void } {
  const tray = new Tray(nativeImage.createFromPath(actions.iconPath));
  const refresh = () => {
    const lang = actions.lang();
    let profiles: { id: string; name: string }[] = [];
    try {
      profiles = loadProfiles();
    } catch {
      profiles = [];
    }
    tray.setToolTip(t(lang, 'tray.tooltip'));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t(lang, 'tray.open'), click: () => actions.show() },
        { type: 'separator' },
        ...profiles.map((p) => ({ label: t(lang, 'tray.test', { name: p.name }), click: () => actions.show({ screen: 'test', profileId: p.id }) })),
        ...(profiles.length ? [{ type: 'separator' as const }] : []),
        { label: t(lang, 'tray.claude'), click: () => actions.show({ screen: 'claude' }) },
        { type: 'separator' },
        { label: t(lang, 'tray.quit'), click: actions.quit },
      ]),
    );
  };
  tray.on('click', () => actions.show());
  refresh();
  return { tray, refresh };
}
