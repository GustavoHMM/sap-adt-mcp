import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  CheckmarkCircle20Filled,
  Circle20Regular,
  Copy20Regular,
  DismissCircle20Filled,
  ShieldCheckmark20Regular,
  Warning20Filled,
} from '@fluentui/react-icons';
import type { CertificateOffer, ProfileView, TestEvent, TestStep } from '../shared/api.ts';
import { api } from './api.ts';
import { useI18n, type UiKey } from './i18n.tsx';

const STEP_ORDER: TestStep['step'][] = ['url', 'proxy', 'dns', 'tcp', 'tls', 'adt', 'csrf', 'mcp', 'claude'];

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, margin: 0, padding: 0, listStyleType: 'none' },
  item: { display: 'grid', gridTemplateColumns: '24px 1fr', columnGap: tokens.spacingHorizontalS, alignItems: 'start' },
  title: { fontWeight: tokens.fontWeightSemibold },
  lines: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  muted: { color: tokens.colorNeutralForeground3 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  warn: { color: tokens.colorPaletteYellowForeground2 },
  fail: { color: tokens.colorPaletteRedForeground1 },
  fix: {
    marginTop: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  quote: { whiteSpace: 'pre-wrap', fontFamily: tokens.fontFamilyBase },
  certGrid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXXS, wordBreak: 'break-all' },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  footer: { marginTop: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

interface Props {
  profile: ProfileView;
  autoStart?: boolean;
  onProfileChanged: (profile: ProfileView) => void;
  onFinished?: (passed: boolean) => void;
}

/** Copy-ready texts for other teams, shown in a box with a copy button. */
const TEXT_KINDS = new Set(['basis', 'it']);

export function TestPanel({ profile, autoStart, onProfileChanged, onFinished }: Props) {
  const { t } = useI18n();
  const styles = useStyles();
  const [steps, setSteps] = useState<Partial<Record<TestStep['step'], TestStep>>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trustOffer, setTrustOffer] = useState<CertificateOffer | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const early = useRef<TestEvent[]>([]);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const apply = useCallback((event: TestEvent) => {
    if (event.kind === 'step') setSteps((s) => ({ ...s, [event.step.step]: event.step }));
    else if (event.kind === 'error') setError(event.message);
    else {
      setRunning(false);
      setFinished(true);
      runIdRef.current = null;
      // Read the latest steps after React applies the pending updates.
      setTimeout(() => {
        const all = Object.values(stepsRef.current);
        onFinishedRef.current?.(all.length > 0 && all.every((s) => s && s.status !== 'fail'));
      }, 0);
    }
  }, []);

  useEffect(
    () =>
      api.onTestEvent((event) => {
        if (runIdRef.current === null) early.current.push(event);
        else if (event.runId === runIdRef.current) apply(event);
      }),
    [apply],
  );

  const run = useCallback(async () => {
    setSteps({});
    setError(null);
    setFinished(false);
    setRunning(true);
    early.current = [];
    const runId = await api.startTest(profile.id);
    runIdRef.current = runId;
    for (const event of early.current.splice(0)) if (event.runId === runId) apply(event);
  }, [profile.id, apply]);

  useEffect(() => {
    if (autoStart) void run();
    return () => {
      if (runIdRef.current) void api.cancelTest(runIdRef.current);
    };
    // Starts once per profile id, not again when the profile object is refreshed.
  }, [profile.id]);

  const changed = async (updated: ProfileView) => {
    onProfileChanged(updated);
    await run();
  };

  // The dialog lives here, outside the step list, so re-running the test never
  // unmounts it half-closed (that left the page hidden from assistive technology).
  const confirmTrust = async () => {
    if (!trustOffer) return;
    setTrustBusy(true);
    try {
      const updated = await api.trustCertificate(profile.id, trustOffer.pem, trustOffer.fingerprint256);
      setTrustOffer(null);
      await changed(updated);
    } finally {
      setTrustBusy(false);
    }
  };

  const values = Object.values(steps).filter(Boolean) as TestStep[];
  const failed = values.some((s) => s.status === 'fail');
  const claudeWarning = steps.claude && steps.claude.status !== 'ok' && steps.claude.status !== 'skip';
  const firstPending = STEP_ORDER.find((id) => !steps[id]);

  return (
    <div>
      <ul className={styles.list} aria-label={t('test.title')}>
        {STEP_ORDER.map((id) => {
          const step = steps[id];
          const [main, ...rest] = step?.lines ?? [];
          const showFixes = step && (step.status === 'fail' || step.lines.some((l) => TEXT_KINDS.has(l.kind)));
          return (
            <li key={id} className={styles.item} data-step={id} data-status={step?.status ?? 'pending'}>
              <StatusIcon status={step?.status} spinning={running && id === firstPending} />
              <div className={styles.lines}>
                <Body1>
                  <span className={styles.title}>{t(`test.step.${id}` as UiKey)}</span>
                  {main ? `: ${main.text}` : <span className={styles.muted}> · {t('test.pending')}</span>}
                </Body1>
                {rest
                  // Certificate details are shown once, in the box with the trust button.
                  .filter((l) => !TEXT_KINDS.has(l.kind) && !(l.key === 'test.tls.details' && step?.data?.certificate))
                  .map((l, i) => (
                    <Caption1 key={i} className={l.kind === 'action' ? undefined : styles.muted}>
                      {l.kind === 'action' ? '→ ' : ''}
                      {l.text}
                    </Caption1>
                  ))}
                {showFixes && <StepFixes step={step} profile={profile} onChanged={changed} onRequestTrust={setTrustOffer} />}
              </div>
            </li>
          );
        })}
      </ul>

      <div className={styles.footer}>
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>{t('test.errorTitle')}</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        )}
        {finished && !failed && !error && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>{t('test.successTitle')}</MessageBarTitle>
              {t('test.successBody')}
            </MessageBarBody>
          </MessageBar>
        )}
        {finished && claudeWarning && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>{t('test.claudeTitle')}</MessageBarTitle>
              {t('test.claudeBody')}
            </MessageBarBody>
          </MessageBar>
        )}
        {finished && failed && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>{t('test.failTitle')}</MessageBarTitle>
              {t('test.failBody')}
            </MessageBarBody>
          </MessageBar>
        )}
        <div>
          <Button icon={running ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />} disabled={running} onClick={() => void run()}>
            {running ? t('test.running') : finished ? t('test.again') : t('test.run')}
          </Button>
        </div>
      </div>

      <Dialog open={trustOffer !== null} onOpenChange={(_, d) => !d.open && !trustBusy && setTrustOffer(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('fix.trustTitle')}</DialogTitle>
            <DialogContent>
              <Body1>{t('fix.trustBody', { id: profile.id })}</Body1>
              {trustOffer && (
                <div style={{ marginTop: 12 }}>
                  <CertificateDetails certificate={trustOffer} />
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setTrustOffer(null)} disabled={trustBusy}>
                {t('common.cancel')}
              </Button>
              <Button appearance="primary" onClick={() => void confirmTrust()} disabled={trustBusy}>
                {t('fix.trustConfirm')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function StatusIcon({ status, spinning }: { status?: TestStep['status']; spinning: boolean }) {
  const styles = useStyles();
  if (spinning) return <Spinner size="extra-tiny" />;
  if (status === 'ok') return <CheckmarkCircle20Filled className={styles.ok} aria-label="ok" />;
  if (status === 'warn') return <Warning20Filled className={styles.warn} aria-label="warning" />;
  if (status === 'fail') return <DismissCircle20Filled className={styles.fail} aria-label="failed" />;
  return <Circle20Regular className={styles.muted} aria-hidden />;
}

interface FixProps {
  step: TestStep;
  profile: ProfileView;
  onChanged: (p: ProfileView) => Promise<void>;
  onRequestTrust: (certificate: CertificateOffer) => void;
}

function StepFixes({ step, profile, onChanged, onRequestTrust }: FixProps) {
  const { t } = useI18n();
  const styles = useStyles();
  const mainKey = step.lines[0]?.key;

  const switchUrl = async (origin: string) => {
    const result = await api.saveProfile({ isNew: false, profile: { ...profile, url: origin } });
    if (result.ok) await onChanged(result.profile);
  };

  const parts = [];
  const certificate = step.step === 'tls' ? step.data?.certificate : undefined;
  if (certificate) {
    parts.push(
      <div key="cert" className={styles.lines}>
        <CertificateDetails certificate={certificate} />
        <div>
          <Button appearance="primary" icon={<ShieldCheckmark20Regular />} onClick={() => onRequestTrust(certificate)}>
            {t('fix.trust', { id: profile.id })}
          </Button>
        </div>
      </div>,
    );
  }
  if (step.data?.certificateNames?.length) {
    parts.push(
      <div key="names" className={styles.buttons}>
        {step.data.certificateNames.map((name) => {
          const u = new URL(profile.url);
          u.hostname = name;
          return (
            <Button key={name} onClick={() => void switchUrl(u.origin)}>
              {t('fix.useName', { name })}
            </Button>
          );
        })}
      </div>,
    );
  }
  if (step.data?.redirectOrigin) {
    const origin = step.data.redirectOrigin;
    parts.push(
      <div key="redirect">
        <Button appearance="primary" onClick={() => void switchUrl(origin)}>
          {t('fix.useOrigin', { origin })}
        </Button>
      </div>,
    );
  }
  if (mainKey === 'test.adt.401' || mainKey === 'relay.noPassword') parts.push(<PasswordFix key="pw" profile={profile} onChanged={onChanged} />);
  for (const line of step.lines.filter((l) => TEXT_KINDS.has(l.kind))) {
    parts.push(<CopyText key={line.key} text={line.text} label={line.kind === 'it' ? t('fix.itCopy') : t('fix.basisCopy')} />);
  }

  return parts.length ? <div className={styles.fix}>{parts}</div> : null;
}

function CertificateDetails({ certificate }: { certificate: CertificateOffer }) {
  const { t } = useI18n();
  const styles = useStyles();
  return (
    <div className={styles.certGrid}>
      <Caption1>{t('fix.certSubject')}</Caption1>
      <Caption1>{certificate.subject}</Caption1>
      <Caption1>{t('fix.certIssuer')}</Caption1>
      <Caption1>{certificate.issuer}</Caption1>
      <Caption1>{t('fix.certValidity')}</Caption1>
      <Caption1>
        {certificate.validFrom} → {certificate.validTo}
      </Caption1>
      <Caption1>{t('fix.certFingerprint')}</Caption1>
      <Caption1>{certificate.fingerprint256}</Caption1>
    </div>
  );
}

function PasswordFix({ profile, onChanged }: { profile: ProfileView; onChanged: (p: ProfileView) => Promise<void> }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!password) return;
    setBusy(true);
    try {
      await api.setPassword(profile.id, password);
      setPassword('');
      await onChanged({ ...profile, hasPassword: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t('fix.passwordLabel')} hint={t('fix.passwordWarning')}>
        <Input type="password" value={password} autoComplete="new-password" onChange={(_, d) => setPassword(d.value)} />
      </Field>
      <div style={{ marginTop: 8 }}>
        <Button appearance="primary" type="submit" disabled={!password || busy}>
          {t('fix.passwordSave')}
        </Button>
      </div>
    </form>
  );
}

function CopyText({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Text className={styles.quote}>{text}</Text>
      <div>
        <Button
          icon={<Copy20Regular />}
          onClick={() => {
            void api.copyText(text).then(() => setCopied(true));
          }}
        >
          {copied ? t('common.copied') : label}
        </Button>
      </div>
    </>
  );
}
