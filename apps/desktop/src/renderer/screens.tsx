import { useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Radio,
  RadioGroup,
  Switch,
  Subtitle2,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Edit20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import type { AppInfo, Lang, ProfileView, UpdateStatus } from '../shared/api.ts';
import { api } from './api.ts';
import { ProfileForm } from './ProfileForm.tsx';
import { TestPanel } from './TestPanel.tsx';
import { useI18n, type UiKey } from './i18n.tsx';

const useStyles = makeStyles({
  screen: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '820px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cards: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  meta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS },
  grid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS },
});

const envColor = { DEV: 'success', QAS: 'warning', PRD: 'danger' } as const;

export function ProfilesScreen({ info, profiles, reload, onTest }: { info: AppInfo; profiles: ProfileView[]; reload: () => Promise<void>; onTest: (id: string) => void }) {
  const { t } = useI18n();
  const styles = useStyles();
  const [editing, setEditing] = useState<{ profile?: ProfileView } | null>(null);
  const [testing, setTesting] = useState<ProfileView | null>(null);
  const [deleting, setDeleting] = useState<ProfileView | null>(null);

  if (editing) {
    return (
      <div className={styles.screen}>
        <Title3 as="h1">{editing.profile ? t('form.editTitle', { name: editing.profile.name }) : t('form.newTitle')}</Title3>
        <ProfileForm
          initial={editing.profile}
          sapLanguage={info.sapLanguage}
          onCancel={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            setTesting(p);
            void reload();
          }}
        />
      </div>
    );
  }

  if (testing) {
    return (
      <div className={styles.screen}>
        <Title3 as="h1">
          {t('test.title')} · {testing.name}
        </Title3>
        <TestPanel profile={testing} autoStart onProfileChanged={(p) => (setTesting(p), void reload())} />
        <div>
          <Button appearance="primary" onClick={() => setTesting(null)}>
            {t('common.finish')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={styles.header}>
        <Title3 as="h1">{t('profiles.title')}</Title3>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setEditing({})}>
          {t('profiles.new')}
        </Button>
      </div>
      {profiles.length === 0 && <Body1>{t('profiles.empty')}</Body1>}
      <div className={styles.cards}>
        {profiles.map((p) => (
          <Card key={p.id} data-profile={p.id}>
            <CardHeader
              header={
                <Subtitle2>
                  {p.name} <Badge appearance="tint" color={envColor[p.environment]}>{p.environment}</Badge>
                </Subtitle2>
              }
              description={
                <div className={styles.meta}>
                  <Caption1>{p.url}</Caption1>
                  <Caption1>{t('profiles.client', { client: p.client })}</Caption1>
                  <Caption1>{t('profiles.user', { user: p.username })}</Caption1>
                  <Caption1>{p.hasPassword ? t('profiles.passwordSaved') : t('profiles.passwordMissing')}</Caption1>
                  {p.trustedCertificate && <Caption1>{t('profiles.certTrusted')}</Caption1>}
                  <Caption1>{p.mcpServer}</Caption1>
                </div>
              }
            />
            <div className={styles.actions}>
              <Button icon={<PlugConnected20Regular />} onClick={() => onTest(p.id)}>
                {t('common.test')}
              </Button>
              <Button icon={<Edit20Regular />} onClick={() => setEditing({ profile: p })}>
                {t('common.edit')}
              </Button>
              <Button icon={<Delete20Regular />} onClick={() => setDeleting(p)}>
                {t('common.delete')}
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <Dialog open={deleting !== null} onOpenChange={(_, d) => !d.open && setDeleting(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('profiles.deleteTitle', { name: deleting?.name ?? '' })}</DialogTitle>
            <DialogContent>{t('profiles.deleteBody')}</DialogContent>
            <DialogActions>
              <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
              <Button
                appearance="primary"
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  if (target) void api.deleteProfile(target.id).then(reload);
                }}
              >
                {t('common.delete')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export function TestScreen({ profiles, selectedId, onSelect, reload }: { profiles: ProfileView[]; selectedId: string | null; onSelect: (id: string) => void; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const styles = useStyles();
  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0];
  if (!selected) return <Body1>{t('test.noProfiles')}</Body1>;
  return (
    <div className={styles.screen}>
      <Title3 as="h1">{t('test.title')}</Title3>
      <Field label={t('test.choose')}>
        <Dropdown value={selected.name} selectedOptions={[selected.id]} onOptionSelect={(_, d) => d.optionValue && onSelect(d.optionValue)}>
          {profiles.map((p) => (
            <Option key={p.id} value={p.id} text={p.name}>
              {p.name} ({p.environment})
            </Option>
          ))}
        </Dropdown>
      </Field>
      <TestPanel key={selected.id} profile={selected} autoStart={selectedId === selected.id} onProfileChanged={() => void reload()} />
    </div>
  );
}

export function AboutScreen({ info, onLanguage }: { info: AppInfo; onLanguage: (lang: Lang | null) => void }) {
  const { t } = useI18n();
  const styles = useStyles();
  const update = useUpdateStatus();
  const [startWithWindows, setStartWithWindows] = useState<boolean | null>(null);
  useEffect(() => {
    void api.getStartWithWindows().then(setStartWithWindows);
  }, []);
  const server = info.cli
    ? `${info.cli.upstream.name} ${info.cli.upstream.version}${info.cli.upstream.commit ? ` (git ${info.cli.upstream.commit.slice(0, 7)})` : ''}`
    : t('about.unavailable');
  return (
    <div className={styles.screen}>
      <Title3 as="h1">{t('about.title')}</Title3>
      {info.cli?.missingComponents?.length ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>{t('about.incompleteTitle')}</MessageBarTitle>
            {t('about.incompleteBody', { components: info.cli.missingComponents.join(', ') })}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      <div className={styles.grid}>
        <Body1>{t('about.app')}</Body1>
        <Body1>{info.version}</Body1>
        <Body1>{t('about.server')}</Body1>
        <Body1 data-testid="upstream-version">{server}</Body1>
        <Body1>{t('about.runtime')}</Body1>
        <Body1>{info.cli ? `Node ${info.cli.node} · ${info.cli.arch}` : t('about.unavailable')}</Body1>
        <Body1>{t('about.updates')}</Body1>
        <div>
          <Body1>{t(`update.${update.state}` as UiKey, { version: update.version ?? '', percent: update.percent ?? 0 })}</Body1>
          {update.state === 'ready' && (
            <div style={{ marginTop: 8 }}>
              <Button appearance="primary" onClick={() => void api.installUpdate()}>
                {t('update.installNow')}
              </Button>
            </div>
          )}
        </div>
      </div>
      <Body1>{t('about.credit')}</Body1>
      <Body1>{t('about.privacy')}</Body1>
      <div>
        <Button onClick={() => void api.openNotices()}>{t('about.notices')}</Button>
      </div>
      <DiagnosticsSection />
      {startWithWindows !== null && (
        <Switch
          checked={startWithWindows}
          label={t('about.startWithWindows')}
          onChange={(_, d) => {
            setStartWithWindows(d.checked);
            void api.setStartWithWindows(d.checked);
          }}
        />
      )}
      <Field label={t('about.language')}>
        <RadioGroup value={info.langSetting ?? 'system'} onChange={(_, d) => onLanguage(d.value === 'system' ? null : (d.value as Lang))}>
          <Radio value="system" label={t('about.langSystem')} />
          <Radio value="pt" label="Português (Brasil)" />
          <Radio value="en" label="English" />
        </RadioGroup>
      </Field>
    </div>
  );
}

/** "Generate diagnostics package": a .zip for support, without passwords, cookies, tokens or user names. */
function DiagnosticsSection() {
  const { t } = useI18n();
  const [state, setState] = useState<{ phase: 'idle' | 'running' | 'saved' | 'failed'; file?: string; error?: string }>({ phase: 'idle' });
  const run = async () => {
    setState({ phase: 'running' });
    try {
      const result = await api.createDiagnostics();
      if (result.canceled) setState({ phase: 'idle' });
      else setState(result.ok ? { phase: 'saved', file: result.file } : { phase: 'failed', error: result.error });
    } catch (e) {
      setState({ phase: 'failed', error: (e as Error).message });
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Subtitle2 as="h2">{t('about.support')}</Subtitle2>
      <Body1>{t('about.diagnosticsHint')}</Body1>
      <div>
        <Button onClick={() => void run()} disabled={state.phase === 'running'} data-testid="diagnostics">
          {state.phase === 'running' ? t('about.diagnosticsRunning') : t('about.diagnostics')}
        </Button>
      </div>
      {state.phase === 'saved' && (
        <MessageBar intent="success">
          <MessageBarBody>{t('about.diagnosticsSaved', { file: state.file ?? '' })}</MessageBarBody>
        </MessageBar>
      )}
      {state.phase === 'failed' && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>{t('about.diagnosticsFailed')}</MessageBarTitle>
            {state.error}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

/** Update state from the main process, kept live. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'disabled' });
  useEffect(() => {
    void api.updateStatus().then(setStatus);
    return api.onUpdateStatus(setStatus);
  }, []);
  return status;
}