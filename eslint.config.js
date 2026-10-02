const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const eslintPluginPrettierRecommended = require('eslint-plugin-prettier/recommended');
const i18next = require('eslint-plugin-i18next');

module.exports = defineConfig([
  expoConfig,
  eslintPluginPrettierRecommended,
  {
    // No hard-coded UI strings: visible text must come from i18next.
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.{js,jsx,ts,tsx}'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          // Only attributes users read or hear are checked, so technical props
          // such as className, testID or keyboardType stay allowed.
          'jsx-attributes': {
            include: [
              'alt',
              'aria-label',
              'aria-description',
              'placeholder',
              '.*[Ll]abel',
              '.*[Tt]itle',
              '.*[Hh]int',
              '.*[Mm]essage',
              '.*[Dd]escription',
            ],
          },
        },
      ],
    },
  },
  {
    ignores: ['dist/*', '.expo/*', 'coverage/*'],
  },
]);
