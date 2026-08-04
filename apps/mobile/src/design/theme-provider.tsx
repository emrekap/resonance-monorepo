import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { useColorScheme } from 'react-native';

import {
  buildTheme,
  resolveScheme,
  type ColorScheme,
  type Theme,
  type ThemePreference,
} from './theme';

const STORAGE_KEY = 'resonance.theme-preference';

function isPreference(value: string | null): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark';
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  scheme: ColorScheme;
  setPreference: (next: ThemePreference) => void;
  /** False until the stored preference has been read. */
  isReady: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Owns the theme preference and resolves it against the OS scheme.
 *
 * `isReady` exists because the AsyncStorage read is async: without gating the
 * splash on it, the app paints in the OS scheme and then snaps to the user's
 * override. The root layout holds the splash until this is true.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  // RN's `ColorSchemeName` includes Android's 'unspecified', which `theme.ts`
  // deliberately doesn't know about (it stays a pure `'light' | 'dark'`
  // domain type). `resolveScheme` already treats anything but 'dark' as
  // light, so this narrows the type without changing behavior.
  const osScheme = useColorScheme();
  const system = osScheme === 'unspecified' ? null : osScheme;
  const [preference, setPreferenceState] = useState<ThemePreference>('auto');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (isPreference(stored)) setPreferenceState(stored);
      })
      .catch(() => {
        // An unreadable preference is the same as not having one.
      })
      .finally(() => {
        setIsReady(true);
      });
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const scheme = resolveScheme(preference, system);
    return {
      theme: buildTheme(scheme),
      preference,
      scheme,
      isReady,
      setPreference: (next) => {
        setPreferenceState(next);
        // Persisting is not worth blocking the UI on, and a failed write only
        // costs the preference on next launch.
        void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      },
    };
  }, [preference, system, isReady]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useThemePreference() {
  const { preference, scheme, setPreference, isReady } = useThemeContext();
  return { preference, scheme, setPreference, isReady };
}
