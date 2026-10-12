import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { FormScreen } from '@/components/form-screen';
import { QuizForm } from '@/components/quiz-form';
import { ErrorState, StatusMessage } from '@/components/status';
import { adminKey, adminQuizKey, fetchAdminQuiz, updateQuiz } from '@/lib/admin-quizzes';
import { isRuleViolation } from '@/lib/admin-rows';
import type { QuizValues } from '@/lib/quiz-schema';

export default function EditQuizScreen() {
  const { t } = useTranslation();
  const { quizId } = useLocalSearchParams<{ quizId: string }>();
  const queryClient = useQueryClient();
  // The form takes its values once, when it mounts, so it waits for a read
  // made after the screen opened, never a cached row that a publish on the
  // list has outdated. No retries: the admin sees the error and retry at once.
  const quiz = useQuery({
    queryKey: adminQuizKey(quizId),
    queryFn: () => fetchAdminQuiz(quizId),
    retry: false,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const update = useMutation({
    mutationFn: (values: QuizValues) => updateQuiz(quizId, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKey });
      router.replace(`/admin/categories/${quiz.data?.category_id}`);
    },
  });

  return (
    <FormScreen title={t('admin.quizzes.form.editTitle')}>
      {quiz.isError ? (
        <ErrorState
          message={t('admin.quizzes.form.errors.load')}
          retryLabel={t('admin.quizzes.retry')}
          onRetry={() => quiz.refetch()}
          retryDisabled={quiz.isFetching}
        />
      ) : !quiz.isFetchedAfterMount || quiz.data === undefined ? (
        <StatusMessage text={t('admin.quizzes.form.loading')} />
      ) : quiz.data === null ? (
        <AdminNotFound
          message={t('admin.quizzes.form.notFound')}
          backLabel={t('admin.quizzes.form.back')}
          href="/admin/categories"
        />
      ) : (
        <QuizForm
          initial={quiz.data}
          pending={update.isPending}
          failure={
            update.isError
              ? t(
                  // The database refuses to publish a quiz that breaks its rules.
                  isRuleViolation(update.error)
                    ? 'admin.quizzes.errors.publishRules'
                    : 'admin.quizzes.form.errors.save',
                )
              : null
          }
          onSubmit={(values) => update.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
