import type { Locale } from 'expo-localization';

import { pickLanguage } from '@/i18n';

const locale = (languageCode: string | null): Pick<Locale, 'languageCode'> => ({ languageCode });

describe('pickLanguage', () => {
  it('picks German for a German device', () => {
    expect(pickLanguage([locale('de')])).toBe('de');
  });

  it('picks English for an English device', () => {
    expect(pickLanguage([locale('en')])).toBe('en');
  });

  it('falls back to English for an unsupported language', () => {
    expect(pickLanguage([locale('fr')])).toBe('en');
  });

  it('falls back to German when the language is unknown', () => {
    expect(pickLanguage([locale(null)])).toBe('de');
    expect(pickLanguage([])).toBe('de');
  });

  it('uses the first supported language from the preference list', () => {
    expect(pickLanguage([locale('fr'), locale('de')])).toBe('de');
    expect(pickLanguage([locale('fr'), locale('en'), locale('de')])).toBe('en');
  });

  it('falls back to English when no preferred language is supported', () => {
    expect(pickLanguage([locale('fr'), locale('it')])).toBe('en');
    expect(pickLanguage([locale(null), locale('fr')])).toBe('en');
  });
});

describe('i18n startup', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('expo-localization');
  });

  const startWithDeviceLanguage = (languageCode: string): string => {
    jest.doMock('expo-localization', () => ({
      getLocales: () => [{ languageCode }],
    }));
    let language = '';
    jest.isolateModules(() => {
      // A fresh module instance is needed per device language, which only require() gives here.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      language = require('@/i18n').default.language;
    });
    return language;
  };

  it('starts in German on a German device', () => {
    expect(startWithDeviceLanguage('de')).toBe('de');
  });

  it('starts in English on an English device', () => {
    expect(startWithDeviceLanguage('en')).toBe('en');
  });

  it('starts in English on a device with an unsupported language', () => {
    expect(startWithDeviceLanguage('fr')).toBe('en');
  });
});
