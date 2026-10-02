import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales, type Locale } from 'expo-localization';

import de from './locales/de.json';
import en from './locales/en.json';

export const supportedLanguages = ['de', 'en'] as const;
export type Language = (typeof supportedLanguages)[number];

export const resources = {
  de: { translation: de },
  en: { translation: en satisfies typeof de },
} as const;

const isSupported = (languageCode: string): languageCode is Language =>
  (supportedLanguages as readonly string[]).includes(languageCode);

/**
 * German is the main language, so it is used when the device language is unknown.
 * Devices set to any other unsupported language get English.
 */
export function pickLanguage(locales: Pick<Locale, 'languageCode'>[]): Language {
  const languageCodes = locales
    .map((locale) => locale.languageCode)
    .filter((languageCode): languageCode is string => languageCode !== null);

  if (languageCodes.length === 0) {
    return 'de';
  }
  return languageCodes.find(isSupported) ?? 'en';
}

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources,
  lng: pickLanguage(getLocales()),
  fallbackLng: 'de',
  initAsync: false,
  interpolation: {
    // React already escapes rendered values.
    escapeValue: false,
  },
});

export default i18n;
