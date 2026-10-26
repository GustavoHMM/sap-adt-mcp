import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { t, type Lang } from '@abap-adt-mcp/core/messages';
import { loadProfiles } from '@abap-adt-mcp/core/profiles';
import type { NavigateTarget } from '../shared/api.ts';

/** A plain 32x32 badge drawn in code until the product icon exists (phase 4). */
function trayIcon(): NativeImage {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      const inside = dx * dx + dy * dy <= 15 * 15;
      const ring = inside && dx * dx + dy * dy >= 9 * 9;
      const i = (y * size + x) * 4;
      // BGRA: brand blue ring around a white core.
      pixels[i] = ring ? 0xd4 : 0xff;
      pixels[i + 1] = ring ? 0x78 : 0xff;
      pixels[i + 2] = ring ? 0x00 : 0xff;
      pixels[i + 3] = inside ? 0xff : 0x00;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

export interface TrayActions {
  show: (target?: NavigateTarget) => void;
  quit: () => void;
  lang: () => Lang;
}

/** Quick access near the clock: open the app, test a profile, see Claude connections, quit. */
export function createTray(actions: TrayActions): { tray: Tray; refresh: () => void } {
  const tray = new Tray(trayIcon());
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
