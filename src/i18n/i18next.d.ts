import 'i18next';

import type de from './locales/de.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: {
      translation: typeof de;
    };
  }
}
