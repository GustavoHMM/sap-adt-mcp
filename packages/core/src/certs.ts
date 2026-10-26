import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { certsDir } from './paths.ts';
import type { Profile, TrustedCertificate } from './profiles.ts';

/**
 * Stores a server certificate the person chose to trust for one profile. The
 * fingerprint shown to them must match the PEM, so nothing else can be slipped in.
 */
export function saveTrustedCertificate(profileId: string, pem: string, expectedFingerprint256: string): TrustedCertificate {
  const cert = new X509Certificate(pem);
  if (cert.fingerprint256 !== expectedFingerprint256) throw new Error('certificate fingerprint mismatch');
  fs.mkdirSync(certsDir(), { recursive: true });
  const file = path.join(certsDir(), `${profileId}.pem`);
  fs.writeFileSync(file, cert.toString(), 'utf8');
  return {
    file,
    fingerprint256: cert.fingerprint256,
    subject: cert.subject.split('\n').join(', '),
    validTo: new Date(cert.validTo).toISOString().slice(0, 10),
  };
}

/** The per-profile certificate file, when the person chose to trust one and it still exists. */
export function extraCaFile(profile: Profile): string | undefined {
  const file = profile.trustedCertificate?.file;
  return file && fs.existsSync(file) ? file : undefined;
}

/**
 * Same trust the upstream gets with NODE_USE_SYSTEM_CA=1 and NODE_EXTRA_CA_CERTS:
 * Node's bundled roots, the Windows certificate store and the profile's own file.
 */
export function trustedCas(profile: Profile): string[] {
  const list = [...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')];
  const extra = extraCaFile(profile);
  if (extra) list.push(fs.readFileSync(extra, 'utf8'));
  return list;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  subjectAltName?: string;
  selfSigned: boolean;
  pem: string;
}

export function summarizeCertificate(der: Buffer): CertificateSummary {
  const cert = new X509Certificate(der);
  return {
    subject: oneLine(cert.subject),
    issuer: oneLine(cert.issuer),
    validFrom: new Date(cert.validFrom).toISOString().slice(0, 10),
    validTo: new Date(cert.validTo).toISOString().slice(0, 10),
    fingerprint256: cert.fingerprint256,
    subjectAltName: cert.subjectAltName,
    selfSigned: cert.subject === cert.issuer,
    pem: cert.toString(),
  };
}

const oneLine = (dn: string) => dn.split('\n').join(', ');

/** Short display name of a distinguished name: its CN, or else its O. */
export function commonName(dn: string): string {
  return /CN=([^,]+)/.exec(dn)?.[1] ?? /O=([^,]+)/.exec(dn)?.[1] ?? dn;
}
