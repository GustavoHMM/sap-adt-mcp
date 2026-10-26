import { useEffect, useState } from 'react';
import {
  Button,
  Caption1,
  Checkbox,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Radio,
  RadioGroup,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { Environment, ProfileView, SaveProfileResult } from '../shared/api.ts';
import { api } from './api.ts';
import { useI18n, type UiKey } from './i18n.tsx';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '640px' },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS },
  claudeName: { color: tokens.colorNeutralForeground3 },
});

type Problem = Extract<SaveProfileResult, { ok: false }>['problems'][number];

interface Props {
  initial?: ProfileView;
  sapLanguage: string;
  onSaved: (profile: ProfileView) => void;
  onCancel?: () => void;
  submitLabel?: string;
}

export function ProfileForm({ initial, sapLanguage, onSaved, onCancel, submitLabel }: Props) {
  const { t } = useI18n();
  const styles = useStyles();
  const isNew = !initial;

  const [name, setName] = useState(initial?.name ?? '');
  const [nameEdited, setNameEdited] = useState(Boolean(initial));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [urlNotes, setUrlNotes] = useState<string[]>([]);
  const [client, setClient] = useState(initial?.client ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState('');
  const [language, setLanguage] = useState(initial?.language ?? sapLanguage);
  const [environment, setEnvironment] = useState<Environment>(initial?.environment ?? 'QAS');
  const [id, setId] = useState(initial?.id ?? '');
  const [editingId, setEditingId] = useState(false);
  const [idEdited, setIdEdited] = useState(Boolean(initial));
  const [allowHttp, setAllowHttp] = useState(initial?.allowInsecureHttp ?? false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [saving, setSaving] = useState(false);

  const insecure = url.trim().toLowerCase().startsWith('http:');

  // Suggest the identifier ("QAS400") and the friendly name until the person types their own.
  useEffect(() => {
    if (!isNew) return;
    if (!idEdited) void api.suggestProfileId(environment, client).then(setId);
    if (!nameEdited) setName(/^\d{3}$/.test(client) ? `${environment} ${client}` : '');
  }, [environment, client, isNew, idEdited, nameEdited]);

  const normalizeUrl = async () => {
    if (!url.trim()) return;
    const r = await api.normalizeUrl(url);
    if (!r.ok || !r.origin) {
      setUrlNotes([]);
      return;
    }
    setUrl(r.origin);
    setUrlNotes(r.notes);
    if (r.client && !client) setClient(r.client);
  };

  const problemFor = (...keys: Problem[]) => {
    const found = problems.find((p) => keys.includes(p));
    return found ? t(`problem.${found}` as UiKey) : undefined;
  };

  const submit = async () => {
    setSaving(true);
    setProblems([]);
    try {
      const result = await api.saveProfile({
        isNew,
        password,
        profile: {
          id,
          name,
          url,
          client,
          username,
          language,
          environment,
          allowInsecureHttp: insecure && environment !== 'PRD' ? allowHttp : undefined,
          disabledTools: initial?.disabledTools,
        },
      });
      if (result.ok) {
        setPassword('');
        onSaved(result.profile);
      } else {
        setProblems(result.problems);
        if (result.problems.some((p) => p === 'id' || p === 'id-taken')) setEditingId(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const fieldState = (message: string | undefined) => (message ? { validationMessage: message, validationState: 'error' as const } : {});

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={t('form.url')} hint={t('form.urlHint')} required {...fieldState(problemFor('url'))}>
        <Input
          value={url}
          placeholder={t('form.urlPlaceholder')}
          onChange={(_, d) => {
            setUrl(d.value);
            setUrlNotes([]);
          }}
          onBlur={() => void normalizeUrl()}
        />
      </Field>
      {urlNotes.length > 0 && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>{t('form.urlAdjusted')}</MessageBarTitle>
            {urlNotes.join(' ')}
          </MessageBarBody>
        </MessageBar>
      )}
      {insecure && environment === 'PRD' && (
        <MessageBar intent="error">
          <MessageBarBody>{t('form.httpPrd')}</MessageBarBody>
        </MessageBar>
      )}
      {insecure && environment !== 'PRD' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{t('form.httpTitle')}</MessageBarTitle>
            {t('form.httpBody')}
            <div>
              <Checkbox checked={allowHttp} onChange={(_, d) => setAllowHttp(Boolean(d.checked))} label={t('form.httpAccept')} />
            </div>
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.row}>
        <Field label={t('form.client')} required {...fieldState(problemFor('client'))}>
          <Input value={client} inputMode="numeric" maxLength={3} onChange={(_, d) => setClient(d.value.replace(/\D/g, ''))} />
        </Field>
        <Field label={t('form.language')} hint={t('form.languageHint')} {...fieldState(problemFor('language'))}>
          <Input value={language} maxLength={2} onChange={(_, d) => setLanguage(d.value.toUpperCase())} />
        </Field>
      </div>
      <div className={styles.row}>
        <Field label={t('form.user')} required {...fieldState(problemFor('username'))}>
          <Input value={username} autoComplete="off" onChange={(_, d) => setUsername(d.value.toUpperCase())} />
        </Field>
        <Field
          label={t('form.password')}
          required={isNew}
          hint={isNew ? t('form.passwordHint') : t('form.passwordKeep')}
          {...fieldState(problemFor('password-required'))}
        >
          <Input type="password" value={password} autoComplete="new-password" onChange={(_, d) => setPassword(d.value)} />
        </Field>
      </div>

      <Field label={t('form.environment')} {...fieldState(problemFor('environment', 'http-in-prd'))}>
        <RadioGroup layout="horizontal" value={environment} onChange={(_, d) => setEnvironment(d.value as Environment)}>
          {(['DEV', 'QAS', 'PRD'] as const).map((env) => (
            <Radio key={env} value={env} label={t(`form.env.${env}`)} />
          ))}
        </RadioGroup>
      </Field>
      {environment === 'PRD' && <Caption1>{t('form.prdNote')}</Caption1>}

      <Field label={t('form.name')} hint={t('form.nameHint')} required {...fieldState(problemFor('name'))}>
        <Input
          value={name}
          onChange={(_, d) => {
            setName(d.value);
            setNameEdited(true);
          }}
        />
      </Field>

      {editingId && isNew ? (
        <Field label={t('form.id')} hint={t('form.idHint')} required {...fieldState(problemFor('id', 'id-taken'))}>
          <Input
            value={id}
            maxLength={40}
            onChange={(_, d) => {
              setId(d.value);
              setIdEdited(true);
            }}
          />
        </Field>
      ) : (
        <Caption1 className={styles.claudeName}>
          {t('form.claudeName', { server: `abap-adt-${id || '…'}` })}{' '}
          {isNew && <Link onClick={() => setEditingId(true)}>{t('form.changeId')}</Link>}
        </Caption1>
      )}
      {problemFor('http-not-accepted', 'proxy') && (
        <MessageBar intent="error">
          <MessageBarBody>{problemFor('http-not-accepted', 'proxy')}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.actions}>
        <Button appearance="primary" type="submit" disabled={saving} icon={saving ? <Spinner size="tiny" /> : undefined}>
          {saving ? t('form.saving') : (submitLabel ?? t('form.saveAndTest'))}
        </Button>
        {onCancel && (
          <Button onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
