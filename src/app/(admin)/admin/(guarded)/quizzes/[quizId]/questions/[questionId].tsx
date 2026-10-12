import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { FormScreen } from '@/components/form-screen';
import { QuestionForm } from '@/components/question-form';
import { ErrorState, StatusMessage } from '@/components/status';
import { isRuleViolation, isUuid } from '@/lib/admin-rows';
import {
  adminAnswersKey,
  adminQuestionKey,
  fetchAdminAnswers,
  fetchAdminQuestion,
  saveQuestion,
} from '@/lib/admin-questions';
import { adminKey } from '@/lib/admin-quizzes';
import type { QuestionWithAnswersValues } from '@/lib/question-schema';

export default function EditQuestionScreen() {
  const { t } = useTranslation();
  const { quizId, questionId } = useLocalSearchParams<{ quizId: string; questionId: string }>();
  const queryClient = useQueryClient();
  // Read through admin_question() and admin_answers() (the explanation and
  // is_correct are no columns anyone may select), after the screen opened
  // and without retries, like the quiz's edit form. A malformed quiz id names
  // no question, so nothing is asked.
  const validQuiz = isUuid(quizId);
  const readOptions = {
    enabled: validQuiz,
    retry: false,
    gcTime: 0,
    refetchOnMount: 'always',
  } as const;
  const question = useQuery({
    queryKey: adminQuestionKey(questionId),
    queryFn: () => fetchAdminQuestion(questionId),
    ...readOptions,
  });
  const answers = useQuery({
    queryKey: adminAnswersKey(questionId),
    queryFn: () => fetchAdminAnswers(questionId),
    ...readOptions,
    enabled: validQuiz && isUuid(questionId),
  });
  const update = useMutation({
    mutationFn: (values: QuestionWithAnswersValues) => saveQuestion(quizId, questionId, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKey });
      router.replace(`/admin/quizzes/${quizId}`);
    },
  });
  // A question of another quiz is not found under this one.
  const found = question.data?.quiz_id === quizId ? question.data : null;

  return (
    <FormScreen title={t('admin.questions.form.editTitle')}>
      {question.isError || answers.isError ? (
        <ErrorState
          message={t('admin.questions.form.errors.load')}
          retryLabel={t('admin.questions.retry')}
          onRetry={() => {
            if (question.isError) void question.refetch();
            if (answers.isError) void answers.refetch();
          }}
          retryDisabled={question.isFetching || answers.isFetching}
        />
      ) : validQuiz &&
        (!question.isFetchedAfterMount ||
          (question.data != null && !answers.isFetchedAfterMount)) ? (
        <StatusMessage text={t('admin.questions.form.loading')} />
      ) : found === null ? (
        <AdminNotFound
          message={t('admin.questions.form.notFound')}
          backLabel={t('admin.questions.form.back')}
          href={`/admin/quizzes/${quizId}`}
        />
      ) : (
        <QuestionForm
          initial={{
            ...found,
            answers: (answers.data ?? []).map(({ id, text, is_correct }) => ({
              id,
              text,
              is_correct,
            })),
          }}
          pending={update.isPending}
          failure={
            update.isError
              ? t(
                  isRuleViolation(update.error)
                    ? 'admin.questions.form.errors.rules'
                    : 'admin.questions.form.errors.save',
                )
              : null
          }
          onSubmit={(values) => update.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
