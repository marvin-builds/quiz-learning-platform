import { fireEvent, screen } from '@testing-library/react-native';

import QuizScreen from '@/app/(learn)/quizzes/[quizId]';
import i18n from '@/i18n';
import { renderWithQueryClient } from '@/test-utils/render-with-query-client';

// The quiz screen when the attempt starts but the questions read then comes
// back empty, e.g. because the questions were deleted between Start and the
// read. Boundaries: the content reads and the Supabase client (network), the
// session and the router.

const QUIZ_ID = '30000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '60000000-0000-4000-8000-000000000001';

jest.mock('@/lib/content', () => ({
  fetchQuiz: () =>
    Promise.resolve({
      id: '30000000-0000-4000-8000-000000000001',
      category_id: '20000000-0000-4000-8000-000000000001',
      title: 'Hauptstädte',
      description: null,
      questionCount: 3,
    }),
  fetchQuizQuestions: () => Promise.resolve([]),
  fetchAttemptScore: () => Promise.reject(new Error('not expected in this test')),
}));

jest.mock('@/lib/session', () => ({
  ensureSession: () => Promise.resolve({ access_token: 'token' }),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) =>
      name === 'start_attempt'
        ? Promise.resolve({ data: mockAttemptId, error: null })
        : Promise.reject(new Error(`unexpected rpc ${name}`)),
  },
}));
const mockAttemptId = ATTEMPT_ID;

jest.mock('expo-router', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Screen = () => null;
  return {
    ...jest.requireActual('expo-router'),
    Link: ({ href, children }: { href: unknown; children?: unknown }) =>
      createElement(View, { href } as object, children as never),
    Stack: Object.assign(() => null, { Screen }),
    useLocalSearchParams: () => ({ quizId: mockQuizId }),
  };
});
const mockQuizId = QUIZ_ID;

test('shows the no-questions message when the questions are gone after Start', async () => {
  await renderWithQueryClient(<QuizScreen />);

  await fireEvent.press(await screen.findByRole('button', { name: i18n.t('quiz.start') }));

  expect(await screen.findByText(i18n.t('quiz.noQuestions'))).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: i18n.t('quiz.submit') })).toBeNull();
});
