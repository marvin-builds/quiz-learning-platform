import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { FormScreen } from '@/components/form-screen';
import { QuestionForm } from '@/components/question-form';
import { ErrorState, StatusMessage } from '@/components/status';
import { saveFailureKey } from '@/lib/admin-questions';
import { adminQuizKey, fetchAdminQuiz } from '@/lib/admin-quizzes';
import { useSaveQuestion } from '@/lib/use-save-question';

export default function NewQuestionScreen() {
  const { t } = useTranslation();
  const { quizId } = useLocalSearchParams<{ quizId: string }>();
  // The quiz must exist before a question can go into it. Read like the
  // quiz's edit form (same key, so the same options).
  const quiz = useQuery({
    queryKey: adminQuizKey(quizId),
    queryFn: () => fetchAdminQuiz(quizId),
    retry: false,
    gcTime: 0,
  });
  const { mutation: create, imagesLeft } = useSaveQuestion(quizId, null);

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
          failure={create.isError ? t(saveFailureKey(create.error)) : null}
          notice={create.isError && imagesLeft ? t('admin.questions.errors.imageRemove') : null}
          onSubmit={(values) => create.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
