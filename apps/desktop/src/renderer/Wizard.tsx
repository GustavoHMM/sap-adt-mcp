import { useState } from 'react';
import { Body1, Button, MessageBar, MessageBarBody, MessageBarTitle, Subtitle2, Title2, makeStyles, tokens } from '@fluentui/react-components';
import type { AppInfo, ProfileView } from '../shared/api.ts';
import { ProfileForm } from './ProfileForm.tsx';
import { TestPanel } from './TestPanel.tsx';
import { useI18n, type UiKey } from './i18n.tsx';

const STEPS = ['form', 'test', 'claude', 'done'] as const;
type Step = (typeof STEPS)[number];

const useStyles = makeStyles({
  page: { maxWidth: '760px', margin: '0 auto', padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL}`, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  steps: { display: 'flex', gap: tokens.spacingHorizontalL, margin: 0, padding: 0, listStyleType: 'none' },
  step: { color: tokens.colorNeutralForeground3 },
  current: { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS },
  question: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
});

export function Wizard({ info, onDone }: { info: AppInfo; onDone: () => void }) {
  const { t } = useI18n();
  const styles = useStyles();
  const [step, setStep] = useState<Step>('form');
  const [profile, setProfile] = useState<ProfileView | undefined>();
  const [passed, setPassed] = useState(false);

  return (
    <div className={styles.page}>
      <div>
        <Title2 as="h1" block>
          {t('wizard.title')}
        </Title2>
        <Body1 as="p" block>
          {t('wizard.subtitle')}
        </Body1>
      </div>
      <ol className={styles.steps} aria-label="steps">
        {STEPS.map((s, i) => (
          <li key={s} className={s === step ? styles.current : styles.step} aria-current={s === step ? 'step' : undefined}>
            {i + 1}. {t(`wizard.step.${s}` as UiKey)}
          </li>
        ))}
      </ol>

      {step === 'form' && (
        <ProfileForm
          initial={profile}
          sapLanguage={info.sapLanguage}
          onSaved={(p) => {
            setProfile(p);
            setPassed(false);
            setStep('test');
          }}
        />
      )}

      {step === 'test' && profile && (
        <>
          <Subtitle2>{profile.name}</Subtitle2>
          <TestPanel profile={profile} autoStart onProfileChanged={setProfile} onFinished={setPassed} />
          <div className={styles.actions}>
            <Button onClick={() => setStep('form')}>{t('common.back')}</Button>
            <Button appearance="primary" disabled={!passed} onClick={() => setStep('claude')}>
              {t('common.continue')}
            </Button>
          </div>
        </>
      )}

      {step === 'claude' && (
        <>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>{t('claude.soonTitle')}</MessageBarTitle>
              {t('claude.soonBody')}
            </MessageBarBody>
          </MessageBar>
          <div className={styles.actions}>
            <Button onClick={() => setStep('test')}>{t('common.back')}</Button>
            <Button appearance="primary" onClick={() => setStep('done')}>
              {t('common.continue')}
            </Button>
          </div>
        </>
      )}

      {step === 'done' && profile && (
        <>
          <Title2 as="h2">{t('done.title')}</Title2>
          <Body1>{t('done.body', { name: profile.name })}</Body1>
          <Body1>{t('done.example')}</Body1>
          <Body1 className={styles.question}>{t('done.question')}</Body1>
          <div className={styles.actions}>
            <Button appearance="primary" onClick={onDone}>
              {t('common.finish')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
