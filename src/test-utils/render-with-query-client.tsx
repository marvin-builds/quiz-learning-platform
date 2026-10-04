import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

// A fresh client per render keeps the cache from leaking between tests, and
// `retry: false` shows an error state at once instead of after the retries.
// Mutations get an infinite gcTime too: their default of five minutes leaves
// a timer behind that keeps Jest from exiting.
export function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
