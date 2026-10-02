import { render, screen } from '@testing-library/react-native';

import HomeScreen from '@/app/index';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

describe('<HomeScreen />', () => {
  it('renders the German home texts from the translation catalog', async () => {
    await i18n.changeLanguage('de');

    await render(<HomeScreen />);

    expect(screen.getByText(de.home.title)).toBeOnTheScreen();
    expect(screen.getByText(de.home.subtitle)).toBeOnTheScreen();
  });

  it('renders the English home texts when the language is English', async () => {
    await i18n.changeLanguage('en');

    await render(<HomeScreen />);

    expect(screen.getByText(en.home.title)).toBeOnTheScreen();
    expect(screen.getByText(en.home.subtitle)).toBeOnTheScreen();
  });
});
