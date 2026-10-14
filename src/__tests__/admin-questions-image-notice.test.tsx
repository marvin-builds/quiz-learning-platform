// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import QuestionsScreen from '@/app/(admin)/admin/(guarded)/quizzes/[quizId]/index';
import i18n from '@/i18n';

// The question list's notice that an image could not be removed after a save
// (#125) arrives as `?imagesLeft=1`. The list shows it once and then drops
// the parameter, so a reload, a bookmark or a step back through the history
// doesn't show it again when nothing failed. The screen runs in an in-memory
// route tree; the data layer of the list is replaced.

const QUIZ_ID = '20000000-0000-4000-8000-000000000001';

jest.mock('@/lib/admin-questions', () => ({
  adminQuizQuestionsKey: (quizId: string) => ['admin', 'questions', 'quiz', quizId],
  fetchQuizQuestions: () =>
    Promise.resolve({
      quiz: { id: '20000000-0000-4000-8000-000000000001', title: 'Tiere' },
      questions: [],
    }),
  deleteQuestion: jest.fn(),
  reorderQuestions: jest.fn(),
}));

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const flush = () =>
  act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const notice = () => i18n.t('admin.questions.errors.imageRemove');

async function renderAt(url: string) {
  const result = renderRouter(
    { 'admin/quizzes/[quizId]/index': QuestionsScreen },
    { initialUrl: url, wrapper },
  );
  await result;
  await flush();
  return {
    getSearchParams: () => result.getSearchParams(),
    getPathnameWithParams: () => result.getPathnameWithParams(),
  };
}

describe('admin question list: the image-removal notice (#125)', () => {
  it('shows the notice and drops the parameter from the URL, so a reload shows no notice', async () => {
    const result = await renderAt(`/admin/quizzes/${QUIZ_ID}?imagesLeft=1`);

    expect(await screen.findByText(notice())).toBeOnTheScreen();
    await flush();
    expect(result.getSearchParams().imagesLeft).toBeUndefined();
    expect(result.getPathnameWithParams()).toBe(`/admin/quizzes/${QUIZ_ID}`);
    expect(screen.getByText(notice())).toBeOnTheScreen();
  });

  it('shows no notice without the parameter', async () => {
    await renderAt(`/admin/quizzes/${QUIZ_ID}`);

    expect(await screen.findByText('Tiere', { exact: false })).toBeOnTheScreen();
    expect(screen.queryByText(notice())).toBeNull();
  });
});
