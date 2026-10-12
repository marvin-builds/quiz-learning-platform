import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { FormScreen } from '@/components/form-screen';
import { QuestionForm } from '@/components/question-form';
import { ErrorState, StatusMessage } from '@/components/status';
import { isUuid } from '@/lib/admin-rows';
import { adminQuestionKey, fetchAdminQuestion, updateQuestion } from '@/lib/admin-questions';
import { adminKey } from '@/lib/admin-quizzes';
import type { QuestionValues } from '@/lib/question-schema';

export default function EditQuestionScreen() {
  const { t } = useTranslation();
  const { quizId, questionId } = useLocalSearchParams<{ quizId: string; questionId: string }>();
  const queryClient = useQueryClient();
  // Read through admin_question() (the explanation is no column anyone may
  // select), after the screen opened and without retries, like the quiz's
  // edit form. A malformed quiz id names no question, so nothing is asked.
  const validQuiz = isUuid(quizId);
  const question = useQuery({
    queryKey: adminQuestionKey(questionId),
    queryFn: () => fetchAdminQuestion(questionId),
    enabled: validQuiz,
    retry: false,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const update = useMutation({
    mutationFn: (values: QuestionValues) => updateQuestion(questionId, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKey });
      router.replace(`/admin/quizzes/${quizId}`);
    },
  });
  // A question of another quiz is not found under this one.
  const found = question.data?.quiz_id === quizId ? question.data : null;

  return (
    <FormScreen title={t('admin.questions.form.editTitle')}>
      {question.isError ? (
        <ErrorState
          message={t('admin.questions.form.errors.load')}
          retryLabel={t('admin.questions.retry')}
          onRetry={() => question.refetch()}
          retryDisabled={question.isFetching}
        />
      ) : validQuiz && !question.isFetchedAfterMount ? (
        <StatusMessage text={t('admin.questions.form.loading')} />
      ) : found === null ? (
        <AdminNotFound
          message={t('admin.questions.form.notFound')}
          backLabel={t('admin.questions.form.back')}
          href={`/admin/quizzes/${quizId}`}
        />
      ) : (
        <QuestionForm
          initial={found}
          pending={update.isPending}
          failed={update.isError}
          onSubmit={(values) => update.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
