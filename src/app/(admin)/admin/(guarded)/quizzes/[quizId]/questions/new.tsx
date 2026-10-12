import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { FormScreen } from '@/components/form-screen';
import { QuestionForm } from '@/components/question-form';
import { ErrorState, StatusMessage } from '@/components/status';
import { createQuestion } from '@/lib/admin-questions';
import { adminKey, adminQuizKey, fetchAdminQuiz } from '@/lib/admin-quizzes';
import type { QuestionValues } from '@/lib/question-schema';

export default function NewQuestionScreen() {
  const { t } = useTranslation();
  const { quizId } = useLocalSearchParams<{ quizId: string }>();
  const queryClient = useQueryClient();
  // The quiz must exist before a question can go into it. Read like the
  // quiz's edit form (same key, so the same options).
  const quiz = useQuery({
    queryKey: adminQuizKey(quizId),
    queryFn: () => fetchAdminQuiz(quizId),
    retry: false,
    gcTime: 0,
  });
  const create = useMutation({
    mutationFn: (values: QuestionValues) => createQuestion(quizId, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKey });
      router.replace(`/admin/quizzes/${quizId}`);
    },
  });

  return (
    <FormScreen title={t('admin.questions.form.createTitle')}>
      {quiz.isPending ? (
        <StatusMessage text={t('admin.questions.form.loading')} />
      ) : quiz.isError ? (
        <ErrorState
          message={t('admin.questions.form.errors.load')}
          retryLabel={t('admin.questions.retry')}
          onRetry={() => quiz.refetch()}
          retryDisabled={quiz.isFetching}
        />
      ) : quiz.data === null ? (
        <AdminNotFound
          message={t('admin.questions.notFound')}
          backLabel={t('admin.questions.back')}
          href="/admin/categories"
        />
      ) : (
        <QuestionForm
          pending={create.isPending}
          failed={create.isError}
          onSubmit={(values) => create.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
