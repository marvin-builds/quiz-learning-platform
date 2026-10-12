import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { FormScreen } from '@/components/form-screen';
import { QuestionForm } from '@/components/question-form';
import { ErrorState, StatusMessage } from '@/components/status';
import { isUuid } from '@/lib/admin-rows';
import {
  adminAnswersKey,
  adminQuestionKey,
  fetchAdminAnswers,
  fetchAdminQuestion,
  saveFailureKey,
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
  // A question of another quiz is not found under this one.
  const found = question.data?.quiz_id === quizId ? question.data : null;
  const initial = found && {
    ...found,
    answers: (answers.data ?? []).map(({ id, text, is_correct, image_path, image_alt }) => ({
      id,
      text,
      is_correct,
      image_path,
      image_alt,
    })),
  };

  const update = useMutation({
    // The stored images, whose objects go once the save replaced or removed them.
    mutationFn: (values: QuestionWithAnswersValues) =>
      saveQuestion(
        quizId,
        questionId,
        values,
        [initial, ...(initial?.answers ?? [])].flatMap((image) =>
          image?.image_path ? [image.image_path] : [],
        ),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKey });
      router.replace(`/admin/quizzes/${quizId}`);
    },
  });
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
      ) : initial === null ? (
        <AdminNotFound
          message={t('admin.questions.form.notFound')}
          backLabel={t('admin.questions.form.back')}
          href={`/admin/quizzes/${quizId}`}
        />
      ) : (
        <QuestionForm
          initial={initial}
          pending={update.isPending}
          failure={update.isError ? t(saveFailureKey(update.error)) : null}
          onSubmit={(values) => update.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
