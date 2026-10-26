import { useCallback, useEffect, useState } from 'react';
import { FluentProvider, Spinner, Subtitle1, Tab, TabList, makeStyles, tokens, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { Beaker20Regular, Info20Regular, People20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import type { AppInfo, Lang, ProfileView } from '../shared/api.ts';
import { api } from './api.ts';
import { I18nProvider, makeTranslate } from './i18n.tsx';
import { ClaudeScreen } from './ClaudeScreen.tsx';
import { AboutScreen, ProfilesScreen, TestScreen } from './screens.tsx';
import { Wizard } from './Wizard.tsx';

const useStyles = makeStyles({
  root: { height: '100%', backgroundColor: tokens.colorNeutralBackground2, overflow: 'auto' },
  shell: { display: 'grid', gridTemplateColumns: '200px 1fr', height: '100%' },
  nav: { padding: tokens.spacingHorizontalM, borderRight: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1 },
  brand: { display: 'block', whiteSpace: 'nowrap', padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}` },
  content: { padding: tokens.spacingHorizontalXXL, overflow: 'auto' },
  center: { height: '100%', display: 'grid', placeItems: 'center' },
});

type Screen = 'profiles' | 'test' | 'claude' | 'about';

function useDarkMode(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const listener = (e: MediaQueryListEvent) => setDark(e.matches);
    m.addEventListener('change', listener);
    return () => m.removeEventListener('change', listener);
  }, []);
  return dark;
}

export function App() {
  const styles = useStyles();
  const dark = useDarkMode();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null);
  const [wizard, setWizard] = useState(false);
  const [screen, setScreen] = useState<Screen>('profiles');
  const [testId, setTestId] = useState<string | null>(null);

  const reload = useCallback(async () => setProfiles(await api.listProfiles()), []);

  useEffect(() => {
    void (async () => {
      const [i, p] = await Promise.all([api.appInfo(), api.listProfiles()]);
      setInfo(i);
      setProfiles(p);
      setWizard(p.length === 0);
    })();
  }, []);

  // The tray menu can open a profile's test or the Claude screen.
  useEffect(
    () =>
      api.onNavigate((target) => {
        setWizard(false);
        setScreen(target.screen);
        if (target.profileId) setTestId(target.profileId);
      }),
    [],
  );

  const changeLanguage = async (lang: Lang | null) => {
    await api.setLanguage(lang);
    setInfo(await api.appInfo());
  };

  const lang: Lang = info?.lang ?? 'pt';
  const t = makeTranslate(lang);

  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme} className={styles.root}>
      <I18nProvider lang={lang}>
        {!info || !profiles ? (
          <div className={styles.center}>
            <Spinner label={t('common.loading')} />
          </div>
        ) : wizard ? (
          <Wizard
            info={info}
            onDone={() => {
              setWizard(false);
              setScreen('profiles');
              void reload();
            }}
          />
        ) : (
          <div className={styles.shell}>
            <nav className={styles.nav}>
              <Subtitle1 className={styles.brand}>{t('app.title')}</Subtitle1>
              <TabList vertical selectedValue={screen} onTabSelect={(_, d) => setScreen(d.value as Screen)}>
                <Tab value="profiles" icon={<People20Regular />}>
                  {t('nav.profiles')}
                </Tab>
                <Tab value="test" icon={<Beaker20Regular />}>
                  {t('nav.test')}
                </Tab>
                <Tab value="claude" icon={<PlugConnected20Regular />}>
                  {t('nav.claude')}
                </Tab>
                <Tab value="about" icon={<Info20Regular />}>
                  {t('nav.about')}
                </Tab>
              </TabList>
            </nav>
            <main className={styles.content}>
              {screen === 'profiles' && (
                <ProfilesScreen
                  info={info}
                  profiles={profiles}
                  reload={reload}
                  onTest={(id) => {
                    setTestId(id);
                    setScreen('test');
                  }}
                />
              )}
              {screen === 'test' && <TestScreen profiles={profiles} selectedId={testId} onSelect={setTestId} reload={reload} />}
              {screen === 'claude' && <ClaudeScreen profiles={profiles} reload={reload} />}
              {screen === 'about' && <AboutScreen info={info} onLanguage={(l) => void changeLanguage(l)} />}
            </main>
          </div>
        )}
      </I18nProvider>
    </FluentProvider>
  );
}
