/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  // NativeWind 4 throws "Cannot manually set color scheme" on web with the default 'media' mode.
  darkMode: 'class',
  theme: {
    extend: {},
  },
  plugins: [],
};
