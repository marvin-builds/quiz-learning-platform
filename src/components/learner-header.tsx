import { useQuery } from '@tanstack/react-query';
import { router, usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { NavButton, NavLink } from '@/components/nav-control';
import { useIsAdmin } from '@/lib/admin';
import { fetchCategoryWithQuizzes, fetchQuiz } from '@/lib/content';
import { createScreenReports } from '@/lib/screen-reports';

/** How far the current attempt got: no answer sent yet, at least one, or the result shown. */
export type QuizProgress = 'idle' | 'answered' | 'finished';

/** What a quiz screen reports to the learner layout. */
export const quizReports = createScreenReports<{ quizId: string; progress: QuizProgress }>();

/**
 * The learner header: the app name, linking home, and "Verwaltung" for an
 * admin; under it, below home, the way up and the screen's title. The
 * titles are no headings: each screen keeps its own single page heading.
 */
export function LearnerHeader({ progress }: { progress: QuizProgress }) {
  const { t } = useTranslation();
  const { isAdmin } = useIsAdmin();
  // /categories/<id> or /quizzes/<id>
  const [section, id] = usePathname().split('/').filter(Boolean);

  return (
    <View role="banner" className="border-b border-gray-200 bg-white px-2 py-1">
      <View className="mx-auto w-full max-w-2xl">
        <View className="flex-row flex-wrap items-center justify-between">
          <NavLink href="/" label={t('nav.appName')} />
          {isAdmin.data === true ? (
            <NavLink href="/admin/categories" label={t('nav.admin')} />
          ) : null}
        </View>
        {id === undefined ? null : section === 'categories' ? (
          <CategoryBar categoryId={id} />
        ) : section === 'quizzes' ? (
          <QuizBar quizId={id} finished={progress === 'finished'} />
        ) : null}
      </View>
    </View>
  );
}

function CategoryBar({ categoryId }: { categoryId: string }) {
  const { t } = useTranslation();
  // The category screen's own read.
  const category = useQuery({
    queryKey: ['category', categoryId],
    queryFn: () => fetchCategoryWithQuizzes(categoryId),
  });
  return (
    <Bar title={category.data?.name}>
      <NavLink href="/" label={t('nav.categories')} sign="←" />
    </Bar>
  );
}

/**
 * Before and during play "✕ Quiz verlassen" to the quiz's category (home
 * for a quiz that can't be found), which asks once an answer was sent; on
 * the result "← <category>".
 */
function QuizBar({ quizId, finished }: { quizId: string; finished: boolean }) {
  const { t } = useTranslation();
  // The quiz screen's own read.
  const quiz = useQuery({ queryKey: ['quiz', quizId], queryFn: () => fetchQuiz(quizId) });
  const categoryHref = quiz.data ? `/categories/${quiz.data.category_id}` : '/';
  return (
    <Bar title={quiz.data?.title}>
      {finished && quiz.data ? (
        <NavLink href={categoryHref} label={quiz.data.categoryName} sign="←" />
      ) : (
        <NavButton
          label={t('nav.leaveQuiz')}
          sign="✕"
          onPress={() => router.navigate(categoryHref)}
        />
      )}
    </Bar>
  );
}

function Bar({ title, children }: { title: string | undefined; children: ReactNode }) {
  return (
    <View className="flex-row items-center gap-2">
      {children}
      {title ? (
        <Text numberOfLines={1} className="shrink text-base font-semibold text-gray-900">
          {title}
        </Text>
      ) : null}
    </View>
  );
}
