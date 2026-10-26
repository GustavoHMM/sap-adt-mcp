import type { DesktopApi } from '../shared/api.ts';

/** Exposed by the preload; the page has no other way to reach Windows. */
export const api = (window as unknown as { api: DesktopApi }).api;
