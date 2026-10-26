import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Subtitle2,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowDownload20Regular, Copy20Regular, PlugConnected20Regular, PlugDisconnected20Regular, Wrench20Regular } from '@fluentui/react-icons';
import { UPSTREAM_TOOLS } from '@abap-adt-mcp/core/tools';
import type { ClaudeStatus, ClientKind, EntryState, ProfileView } from '../shared/api.ts';
import { api } from './api.ts';
import { useI18n, type UiKey } from './i18n.tsx';

const useStyles = makeStyles({
  screen: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '820px' },
  clients: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalM },
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: { display: 'grid', gridTemplateColumns: '140px 1fr auto', alignItems: 'center', columnGap: tokens.spacingHorizontalM },
  muted: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  path: { color: tokens.colorNeutralForeground3, wordBreak: 'break-all' },
  tools: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
});

const stateColor: Record<EntryState, 'success' | 'informative' | 'warning' | 'danger'> = {
  connected: 'success',
  'not-connected': 'informative',
  outdated: 'warning',
  'removed-externally': 'danger',
};

/** Claude status, refreshed when the window regains focus (the person may have just installed Claude). */
export function useClaudeStatus() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const refresh = useCallback(async () => setStatus(await api.claudeStatus()), []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 30_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [refresh]);
  return { status, refresh };
}

interface Flow {
  /** Asks for the typed confirmation of production profiles. */
  prd: { profile: ProfileView; kind: ClientKind } | null;
  restart: boolean;
}

/** Connect/remove logic shared by the Claude screen and the wizard. */
export function useClaudeActions(status: ClaudeStatus | null, refresh: () => Promise<void>) {
  const [flow, setFlow] = useState<Flow>({ prd: null, restart: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const afterChange = async (restartSuggested: boolean) => {
    await refresh();
    if (restartSuggested) setFlow((f) => ({ ...f, restart: true }));
  };

  const connect = async (profile: ProfileView, kind: ClientKind, confirmation?: string) => {
    if (profile.environment === 'PRD' && confirmation === undefined) {
      setFlow((f) => ({ ...f, prd: { profile, kind } }));
      return;
    }
    setBusy(`${profile.id}:${kind}`);
    setError(null);
    try {
      const r = await api.connectClaude(profile.id, kind, confirmation);
      if (r.ok) await afterChange(r.restartSuggested);
      else setError(r.error);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (profile: ProfileView, kind: ClientKind) => {
    setBusy(`${profile.id}:${kind}`);
    setError(null);
    try {
      const r = await api.disconnectClaude(profile.id, kind);
      await afterChange(r.restartSuggested);
    } finally {
      setBusy(null);
    }
  };

  return { flow, setFlow, busy, error, connect, disconnect, running: Boolean(status?.desktop.running) };
}

export function ClaudeDialogs({ actions }: { actions: ReturnType<typeof useClaudeActions> }) {
  const { t } = useI18n();
  const { flow, setFlow } = actions;
  const [typed, setTyped] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<string | null>(null);
  const prd = flow.prd;

  const restart = async () => {
    setRestarting(true);
    try {
      const r = await api.restartClaudeDesktop();
      setRestartResult(r.ok ? 'done' : r.reason);
      if (r.ok) setFlow((f) => ({ ...f, restart: false }));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <Dialog open={prd !== null} onOpenChange={(_, d) => !d.open && setFlow((f) => ({ ...f, prd: null }))}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('claude.prdTitle')}</DialogTitle>
            <DialogContent>
              <Body1 block>{t('claude.prdBody', { id: prd?.profile.id ?? '' })}</Body1>
              <Field label={t('claude.prdLabel', { id: prd?.profile.id ?? '' })} style={{ marginTop: 12 }}>
                <Input value={typed} onChange={(_, d) => setTyped(d.value)} />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setFlow((f) => ({ ...f, prd: null }))}>{t('common.cancel')}</Button>
              <Button
                appearance="primary"
                disabled={!prd || typed !== prd.profile.id}
                onClick={() => {
                  const target = prd;
                  setFlow((f) => ({ ...f, prd: null }));
                  setTyped('');
                  if (target) void actions.connect(target.profile, target.kind, typed);
                }}
              >
                {t('claude.connect')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={flow.restart} onOpenChange={(_, d) => !d.open && !restarting && setFlow((f) => ({ ...f, restart: false }))}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{actions.running ? t('claude.restartTitle') : t('claude.openTitle')}</DialogTitle>
            <DialogContent>
              <Body1 block>{actions.running ? t('claude.restartBody') : t('claude.openBody')}</Body1>
              {restartResult && restartResult !== 'done' && (
                <MessageBar intent="warning" style={{ marginTop: 12 }}>
                  <MessageBarBody>{t(`claude.restart.${restartResult}` as UiKey)}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setFlow((f) => ({ ...f, restart: false }))} disabled={restarting}>
                {t('claude.later')}
              </Button>
              <Button appearance="primary" onClick={() => void restart()} disabled={restarting} icon={restarting ? <Spinner size="tiny" /> : undefined}>
                {actions.running ? t('claude.restartNow') : t('claude.openNow')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

function ToolsDialog({ profile, open, onClose, onSaved }: { profile: ProfileView; open: boolean; onClose: () => void; onSaved: (p: ProfileView) => void }) {
  const { t, lang } = useI18n();
  const styles = useStyles();
  const [disabled, setDisabled] = useState(new Set(profile.disabledToolsEffective));
  useEffect(() => setDisabled(new Set(profile.disabledToolsEffective)), [profile, open]);
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('claude.toolsTitle', { name: profile.name })}</DialogTitle>
          <DialogContent>
            <Body1 block>{t('claude.toolsBody')}</Body1>
            <div className={styles.tools} style={{ marginTop: 12 }}>
              {UPSTREAM_TOOLS.map((tool) => (
                <Checkbox
                  key={tool.name}
                  checked={!disabled.has(tool.name)}
                  label={`${tool.name}: ${lang === 'pt' ? tool.pt : tool.en}${tool.businessData ? ` ⚠ ${t('claude.toolsBusinessData')}` : ''}`}
                  onChange={(_, d) =>
                    setDisabled((s) => {
                      const next = new Set(s);
                      if (d.checked) next.delete(tool.name);
                      else next.add(tool.name);
                      return next;
                    })
                  }
                />
              ))}
            </div>
            <Caption1 block style={{ marginTop: 12 }}>
              {t('claude.toolsApply')}
            </Caption1>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button appearance="primary" onClick={() => void api.setDisabledTools(profile.id, [...disabled]).then(onSaved)}>
              {t('common.save')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** One profile's connection to Claude Desktop and Claude Code. */
export function ProfileClaudeCard({
  profile,
  status,
  actions,
  onProfileChanged,
}: {
  profile: ProfileView;
  status: ClaudeStatus;
  actions: ReturnType<typeof useClaudeActions>;
  onProfileChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const styles = useStyles();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const states = status.profiles[profile.id];
  const enabledCount = UPSTREAM_TOOLS.filter((tool) => !profile.disabledToolsEffective.includes(tool.name)).length;

  const row = (kind: ClientKind) => {
    const client = status[kind];
    const state = states?.[kind];
    const busy = actions.busy === `${profile.id}:${kind}`;
    const label = t(kind === 'desktop' ? 'claude.desktop' : 'claude.code');
    if (!client.installed) {
      return (
        <div className={styles.row} key={kind}>
          <Body1>{label}</Body1>
          <Caption1 className={styles.muted}>{t('claude.notInstalled')}</Caption1>
          <span />
        </div>
      );
    }
    const s = state?.state ?? 'not-connected';
    return (
      <div className={styles.row} key={kind} data-claude={`${profile.id}:${kind}`} data-state={s}>
        <Body1>{label}</Body1>
        <div>
          <Badge appearance="tint" color={stateColor[s]}>
            {t(`claude.state.${s}` as UiKey)}
          </Badge>
          {state?.lastUsed && (
            <Caption1 className={styles.muted}> · {t('claude.lastUsed', { when: new Date(state.lastUsed).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en') })}</Caption1>
          )}
        </div>
        <div className={styles.actions}>
          {busy && <Spinner size="tiny" />}
          {s === 'connected' ? (
            <Button size="small" icon={<PlugDisconnected20Regular />} disabled={busy} onClick={() => void actions.disconnect(profile, kind)}>
              {t('claude.disconnect')}
            </Button>
          ) : (
            <Button size="small" appearance="primary" icon={<PlugConnected20Regular />} disabled={busy || Boolean(client.problem)} onClick={() => void actions.connect(profile, kind)}>
              {s === 'not-connected' ? t('claude.connect') : t('claude.reconnect')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card className={styles.card} data-claude-profile={profile.id}>
      <Subtitle2>
        {profile.name} <Badge appearance="tint">{profile.environment}</Badge> <Caption1 className={styles.muted}>{profile.mcpServer}</Caption1>
      </Subtitle2>
      {row('desktop')}
      {row('code')}
      <div className={styles.actions}>
        <Button size="small" icon={<Wrench20Regular />} onClick={() => setToolsOpen(true)}>
          {t('claude.tools', { enabled: enabledCount, total: UPSTREAM_TOOLS.length })}
        </Button>
        <Button
          size="small"
          icon={<Copy20Regular />}
          onClick={() => void api.usageInstructions(profile.id).then(api.copyText).then(() => setCopied(true))}
        >
          {copied ? t('common.copied') : t('claude.copyInstructions')}
        </Button>
      </div>
      <ToolsDialog
        profile={profile}
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        onSaved={() => {
          setToolsOpen(false);
          onProfileChanged();
        }}
      />
    </Card>
  );
}

/** Per-client banners: not installed, unknown or corrupted configuration. */
export function ClientBanners({ status, refresh }: { status: ClaudeStatus; refresh: () => Promise<void> }) {
  const { t, lang } = useI18n();
  if (!status.desktop.installed && !status.code.installed) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>{t('claude.noneTitle')}</MessageBarTitle>
          {t('claude.noneBody')}
        </MessageBarBody>
        <MessageBarActions>
          <Button icon={<ArrowDownload20Regular />} onClick={() => void api.openClaudeDownload()}>
            {t('claude.download')}
          </Button>
        </MessageBarActions>
      </MessageBar>
    );
  }
  const banners = [];
  for (const kind of ['desktop', 'code'] as const) {
    const client = status[kind];
    const label = t(kind === 'desktop' ? 'claude.desktop' : 'claude.code');
    if (client.problem === 'config-corrupted') {
      banners.push(
        <MessageBar key={kind} intent="error">
          <MessageBarBody>
            <MessageBarTitle>{t('claude.corruptedTitle', { client: label })}</MessageBarTitle>
            {client.backupTime ? t('claude.corruptedBody', { when: new Date(client.backupTime).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en') }) : t('claude.corruptedNoBackup')}
          </MessageBarBody>
          {client.backupTime && (
            <MessageBarActions>
              <Button onClick={() => void api.restoreClaudeBackup(kind).then(refresh)}>{t('claude.restore')}</Button>
            </MessageBarActions>
          )}
        </MessageBar>,
      );
    } else if (client.problem === 'config-unknown') {
      banners.push(
        <MessageBar key={kind} intent="info">
          <MessageBarBody>{t('claude.configUnknown', { client: label })}</MessageBarBody>
        </MessageBar>,
      );
    }
  }
  return <>{banners}</>;
}

export function ClaudeScreen({ profiles, reload }: { profiles: ProfileView[]; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const styles = useStyles();
  const { status, refresh } = useClaudeStatus();
  const actions = useClaudeActions(status, refresh);
  if (!status) return <Spinner />;
  const removed = profiles.some((p) => ['desktop', 'code'].some((k) => status.profiles[p.id]?.[k as ClientKind]?.state === 'removed-externally'));
  return (
    <div className={styles.screen}>
      <Title3 as="h1">{t('claude.title')}</Title3>
      <ClientBanners status={status} refresh={refresh} />
      <div className={styles.clients}>
        {(['desktop', 'code'] as const).map((kind) => (
          <Card key={kind} className={styles.card}>
            <Subtitle2>{t(kind === 'desktop' ? 'claude.desktop' : 'claude.code')}</Subtitle2>
            <Body1>
              {status[kind].installed
                ? kind === 'desktop'
                  ? status.desktop.running
                    ? t('claude.desktopRunning')
                    : t('claude.desktopClosed')
                  : status.code.cliAvailable
                    ? t('claude.codeCli')
                    : t('claude.codeFile')
                : t('claude.notInstalled')}
            </Body1>
            {status[kind].configPath && <Caption1 className={styles.path}>{status[kind].configPath}</Caption1>}
          </Card>
        ))}
      </div>
      {removed && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{t('claude.removedTitle')}</MessageBarTitle>
            {t('claude.removedBody')}
          </MessageBarBody>
        </MessageBar>
      )}
      {actions.error && (
        <MessageBar intent="error">
          <MessageBarBody>{t(`claude.error.${actions.error}` as UiKey)}</MessageBarBody>
        </MessageBar>
      )}
      {profiles.length === 0 && <Body1>{t('test.noProfiles')}</Body1>}
      {profiles.map((p) => (
        <ProfileClaudeCard key={p.id} profile={p} status={status} actions={actions} onProfileChanged={() => void reload().then(refresh)} />
      ))}
      <ClaudeDialogs actions={actions} />
    </div>
  );
}
