import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';

import {
  AdminNotFound,
  ErrorText,
  MoveActions,
  PrimaryLink,
  RowAction,
  RowLink,
} from '@/components/admin-list';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageTitle } from '@/components/page-title';
import { ErrorState, StatusMessage } from '@/components/status';
import {
  adminQuizQuestionsKey,
  deleteQuestion,
  fetchQuizQuestions,
  reorderQuestions,
} from '@/lib/admin-questions';
import { adminKey } from '@/lib/admin-quizzes';
import { isRuleViolation, movedIds } from '@/lib/admin-rows';

type Question = NonNullable<Awaited<ReturnType<typeof fetchQuizQuestions>>>['questions'][number];

const deleteKey = [...adminKey, 'questions', 'delete'] as const;

export default function AdminQuestionsScreen() {
  const { t } = useTranslation();
  const { quizId } = useLocalSearchParams<{ quizId: string }>();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: adminQuizQuestionsKey(quizId),
    queryFn: () => fetchQuizQuestions(quizId),
  });
  const [toDelete, setToDelete] = useState<Question | null>(null);

  const refetch = () => queryClient.invalidateQueries({ queryKey: adminKey });
  const remove = useMutation({
    mutationKey: deleteKey,
    mutationFn: (question: Question) => deleteQuestion(question.id),
    onSuccess: refetch,
  });
  // Rows whose delete is still in flight: a second delete would find no row.
  const deleting = useMutationState({
    filters: { mutationKey: deleteKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as Question).id,
  });

  // A move sends the whole list in its new order; refused or not, the list
  // is read again, so it shows the server's order. One move at a time.
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderQuestions(quizId, ids),
    onSettled: refetch,
  });
  const move = (from: number, to: number) => {
    if (list.data && !reorder.isPending) reorder.mutate(movedIds(list.data.questions, from, to));
  };

  const confirmDelete = () => {
    if (toDelete) remove.mutate(toDelete);
    setToDelete(null);
  };

  const title = list.data
    ? t('admin.questions.title', { name: list.data.quiz.title })
    : t('admin.dashboard.title');

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={title} />
      <View className="mx-auto w-full max-w-2xl gap-6">
        {list.isPending ? (
          <StatusMessage text={t('admin.questions.loading')} />
        ) : list.isError ? (
          <ErrorState
            message={t('admin.questions.error')}
            retryLabel={t('admin.questions.retry')}
            onRetry={() => list.refetch()}
            retryDisabled={list.isFetching}
          />
        ) : list.data === null ? (
          <AdminNotFound
            message={t('admin.questions.notFound')}
            backLabel={t('admin.questions.back')}
            href="/admin/categories"
          />
        ) : (
          <>
            <Text role="heading" className="text-2xl font-bold text-gray-900">
              {title}
            </Text>
            <PrimaryLink
              label={t('admin.questions.create')}
              href={`/admin/quizzes/${quizId}/questions/new`}
            />
            <RowLink
              label={t('admin.rowActions.preview')}
              name={t('admin.questions.preview', { name: list.data.quiz.title })}
              href={`/admin/quizzes/${quizId}/preview`}
            />
            {remove.isError ? (
              <ErrorText
                text={t(
                  // The database keeps a published quiz from losing its last question.
                  isRuleViolation(remove.error)
                    ? 'admin.questions.errors.deleteLastPublished'
                    : 'admin.questions.errors.delete',
                )}
              />
            ) : null}
            {reorder.isError ? <ErrorText text={t('admin.questions.errors.reorder')} /> : null}
            {list.data.questions.length === 0 ? (
              <StatusMessage text={t('admin.questions.empty')} />
            ) : (
              <View className="gap-3">
                {list.data.questions.map((question, index, questions) => (
                  <View
                    key={question.id}
                    className="gap-3 rounded-xl border border-gray-200 bg-white p-4"
                  >
                    <Text className="text-lg font-semibold text-gray-900">{question.text}</Text>
                    <View className="flex-row flex-wrap gap-2">
                      <RowLink
                        label={t('admin.rowActions.edit')}
                        name={t('admin.questions.actions.edit', { name: question.text })}
                        href={`/admin/quizzes/${quizId}/questions/${question.id}`}
                      />
                      <MoveActions
                        index={index}
                        count={questions.length}
                        upName={t('admin.questions.actions.moveUp', { name: question.text })}
                        downName={t('admin.questions.actions.moveDown', { name: question.text })}
                        onMove={move}
                      />
                      <RowAction
                        label={t('admin.rowActions.delete')}
                        name={t('admin.questions.actions.delete', { name: question.text })}
                        disabled={deleting.includes(question.id)}
                        onPress={() => setToDelete(question)}
                        destructive
                      />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </View>
      <ConfirmDialog
        visible={toDelete !== null}
        title={t('admin.questions.deleteDialog.title', { name: toDelete?.text ?? '' })}
        message={t('admin.questions.deleteDialog.message', { name: toDelete?.text ?? '' })}
        confirmLabel={t('admin.questions.deleteDialog.confirm')}
        cancelLabel={t('admin.questions.deleteDialog.cancel')}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </ScrollView>
  );
}
