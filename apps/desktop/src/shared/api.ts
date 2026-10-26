import type { Environment, Profile, ProfileProblem, TrustedCertificate } from '@abap-adt-mcp/core/profiles';

export type { Environment, Profile, ProfileProblem, TrustedCertificate };
export type Lang = 'pt' | 'en';

export interface AppInfo {
  version: string;
  lang: Lang;
  /** Language chosen in the app, or null when following Windows. */
  langSetting: Lang | null;
  sapLanguage: string;
  arch: string;
  /** What Claude runs: reported by the CLI itself. */
  cli: { version: string; upstream: { name: string; version: string; commit?: string }; node: string; arch: string } | null;
}

export interface ProfileView extends Profile {
  hasPassword: boolean;
  disabledToolsEffective: string[];
  mcpServer: string;
}

export interface UrlView {
  ok: boolean;
  origin?: string;
  client?: string;
  insecure?: boolean;
  /** Plain-language explanation of each change, already translated. */
  notes: string[];
  error?: string;
}

export interface SaveProfileRequest {
  profile: Profile;
  /** New password; omitted or empty keeps the saved one. */
  password?: string;
  /** True when creating: the id must not exist yet. */
  isNew: boolean;
}

export type SaveProfileResult = { ok: true; profile: ProfileView } | { ok: false; problems: (ProfileProblem | 'id-taken' | 'password-required')[] };

export interface TestLine {
  kind: 'main' | 'detail' | 'action' | 'basis' | 'it';
  key: string;
  text: string;
}

export interface CertificateOffer {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  pem: string;
  selfSigned: boolean;
}

export interface TestStep {
  step: 'url' | 'proxy' | 'dns' | 'tcp' | 'tls' | 'adt' | 'csrf' | 'mcp' | 'claude';
  status: 'ok' | 'warn' | 'fail' | 'skip';
  lines: TestLine[];
  data?: { certificate?: CertificateOffer; certificateNames?: string[]; redirectOrigin?: string; [key: string]: unknown };
}

export type TestEvent =
  | { runId: string; kind: 'step'; step: TestStep }
  | { runId: string; kind: 'done'; exitCode: number | null }
  | { runId: string; kind: 'error'; message: string };

/** Everything the window may ask the main process for (exposed by the preload as window.api). */
export interface DesktopApi {
  appInfo(): Promise<AppInfo>;
  setLanguage(lang: Lang | null): Promise<void>;
  listProfiles(): Promise<ProfileView[]>;
  suggestProfileId(environment: Environment, client: string): Promise<string>;
  normalizeUrl(text: string): Promise<UrlView>;
  saveProfile(request: SaveProfileRequest): Promise<SaveProfileResult>;
  deleteProfile(id: string): Promise<void>;
  setPassword(id: string, password: string): Promise<void>;
  trustCertificate(id: string, pem: string, fingerprint256: string): Promise<ProfileView>;
  startTest(id: string): Promise<string>;
  cancelTest(runId: string): Promise<void>;
  onTestEvent(listener: (event: TestEvent) => void): () => void;
  copyText(text: string): Promise<void>;
}
