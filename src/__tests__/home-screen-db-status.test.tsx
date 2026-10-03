import { render, screen } from '@testing-library/react-native';

import HomeScreen from '@/app/index';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// The Supabase client is the network boundary: the home screen reads one value
// from the database through `supabase.rpc('health_check')`.
const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

const statuses = ['loading', 'ok', 'error'] as const;
type Status = (typeof statuses)[number];

const statusText = (status: Status) => i18n.t(`home.dbStatus.${status}`);

const expectOnlyStatus = (shown: Status) => {
  for (const status of statuses.filter((other) => other !== shown)) {
    expect(screen.queryByText(statusText(status))).not.toBeOnTheScreen();
  }
};

describe('<HomeScreen /> database status', () => {
  beforeEach(async () => {
    mockRpc.mockReset();
    await i18n.changeLanguage('de');
  });

  it('has a German and an English text for each database status', () => {
    for (const status of statuses) {
      expect(de).toHaveProperty(['home', 'dbStatus', status], expect.any(String));
      expect(en).toHaveProperty(['home', 'dbStatus', status], expect.any(String));
    }
    const germanTexts = statuses.map((status) => i18n.t(`home.dbStatus.${status}`, { lng: 'de' }));
    expect(new Set(germanTexts).size).toBe(statuses.length);
  });

  it('reads the health check value from the database', async () => {
    mockRpc.mockResolvedValue({ data: 'ok', error: null });

    await render(<HomeScreen />);

    expect(mockRpc).toHaveBeenCalledWith('health_check');
  });

  it('shows a loading status while the health check is pending', async () => {
    mockRpc.mockReturnValue(new Promise(() => {}));

    await render(<HomeScreen />);

    expect(screen.getByText(statusText('loading'))).toBeOnTheScreen();
    expectOnlyStatus('loading');
  });

  it('shows an ok status when the database returns the health check value', async () => {
    mockRpc.mockResolvedValue({ data: 'ok', error: null });

    await render(<HomeScreen />);

    expect(await screen.findByText(statusText('ok'))).toBeOnTheScreen();
    expectOnlyStatus('ok');
  });

  it('shows an error status when the database returns an error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Could not find the function', code: 'PGRST202' },
    });

    await render(<HomeScreen />);

    expect(await screen.findByText(statusText('error'))).toBeOnTheScreen();
    expectOnlyStatus('error');
  });

  it('shows an error status when the request fails', async () => {
    mockRpc.mockRejectedValue(new TypeError('Network request failed'));

    await render(<HomeScreen />);

    expect(await screen.findByText(statusText('error'))).toBeOnTheScreen();
    expectOnlyStatus('error');
  });

  it('shows an error status when the database returns an unexpected value', async () => {
    mockRpc.mockResolvedValue({ data: 'not ok', error: null });

    await render(<HomeScreen />);

    expect(await screen.findByText(statusText('error'))).toBeOnTheScreen();
    expectOnlyStatus('error');
  });

  it('shows the database status in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    mockRpc.mockResolvedValue({ data: 'ok', error: null });

    await render(<HomeScreen />);

    expect(await screen.findByText(i18n.t('home.dbStatus.ok', { lng: 'en' }))).toBeOnTheScreen();
  });
});
