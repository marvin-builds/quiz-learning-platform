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
          // such as className, testID or keyboardType stay allowed. `options`
          // and `screenOptions` (on any component) and `on…` handlers are
          // checked too, so screen titles and Alert.alert texts are caught.
          // Their contents are checked like any JSX expression, apart from the
          // properties and calls below, so a technical literal there (an
          // argument of an unlisted call, a ternary branch) needs a constant.
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
              'options',
              'screenOptions',
              'on[A-Z].*',
            ],
          },
          // Only object properties users read are checked: a title or label,
          // an Alert button's text. Everywhere in JSX, any other key exempts
          // its whole value, so headerTintColor or an Alert button's style stay
          // allowed, but so do JSX under such a key (headerRight) and inline
          // data such as [{ name: 'Mathe' }]; keep such text in i18n keys.
          'object-properties': {
            include: ['.*[Tt]itle', '.*[Ll]abel', 'text'],
          },
          // Everything inside these calls is exempt: the plugin's defaults
          // (t, require, …) plus navigation, setters, links and Supabase
          // queries, which take technical strings in handlers. The plugin also
          // matches them as methods (`x.setY(…)`, `AsyncStorage.setItem`). All
          // other calls are checked, so JSX rendered in .map() or memo() is too.
          callees: {
            exclude: [
              'i18n(ext)?',
              't',
              'require',
              'addEventListener',
              'removeEventListener',
              'postMessage',
              'getElementById',
              'dispatch',
              'commit',
              'includes',
              'indexOf',
              'endsWith',
              'startsWith',
              'router\\..*',
              'navigation\\..*',
              'set[A-Z]\\w*',
              'Linking\\..*',
              'supabase\\..*',
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
