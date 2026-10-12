import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { FormScreen } from '@/components/form-screen';
import { QuizForm } from '@/components/quiz-form';
import { ErrorState, StatusMessage } from '@/components/status';
import { adminCategoryKey, fetchAdminCategory } from '@/lib/admin-categories';
import { adminKey, createQuiz } from '@/lib/admin-quizzes';
import type { QuizValues } from '@/lib/quiz-schema';

export default function NewQuizScreen() {
  const { t } = useTranslation();
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const queryClient = useQueryClient();
  // The category must exist before a quiz can go into it. Read like the
  // category's edit form (same key, so the same options).
  const category = useQuery({
    queryKey: adminCategoryKey(categoryId),
    queryFn: () => fetchAdminCategory(categoryId),
    retry: false,
    gcTime: 0,
  });
  const create = useMutation({
    mutationFn: (values: QuizValues) => createQuiz(categoryId, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKey });
      router.replace(`/admin/categories/${categoryId}`);
    },
  });

  return (
    <FormScreen title={t('admin.quizzes.form.createTitle')}>
      {category.isPending ? (
        <StatusMessage text={t('admin.quizzes.form.loading')} />
      ) : category.isError ? (
        <ErrorState
          message={t('admin.quizzes.form.errors.load')}
          retryLabel={t('admin.quizzes.retry')}
          onRetry={() => category.refetch()}
          retryDisabled={category.isFetching}
        />
      ) : category.data === null ? (
        <AdminNotFound
          message={t('admin.quizzes.notFound')}
          backLabel={t('admin.quizzes.back')}
          href="/admin/categories"
        />
      ) : (
        <QuizForm
          pending={create.isPending}
          failed={create.isError}
          onSubmit={(values) => create.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
