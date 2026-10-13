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
  PublishedBadge,
  RowAction,
  RowLink,
  RowTitle,
} from '@/components/admin-list';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageTitle } from '@/components/page-title';
import { ErrorState, StatusMessage } from '@/components/status';
import {
  adminCategoryQuizzesKey,
  adminKey,
  deleteQuiz,
  fetchCategoryQuizzes,
  reorderQuizzes,
  updateQuiz,
} from '@/lib/admin-quizzes';
import { isRuleViolation, movedIds } from '@/lib/admin-rows';

type Quiz = NonNullable<Awaited<ReturnType<typeof fetchCategoryQuizzes>>>['quizzes'][number];

const toggleKey = [...adminKey, 'quizzes', 'toggle'] as const;
const deleteKey = [...adminKey, 'quizzes', 'delete'] as const;

export default function AdminQuizzesScreen() {
  const { t } = useTranslation();
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: adminCategoryQuizzesKey(categoryId),
    queryFn: () => fetchCategoryQuizzes(categoryId),
  });
  const [toDelete, setToDelete] = useState<Quiz | null>(null);

  // Every successful write reads the admin's data from the server again.
  const refetch = () => queryClient.invalidateQueries({ queryKey: adminKey });
  const toggle = useMutation({
    mutationKey: toggleKey,
    mutationFn: (quiz: Quiz) => updateQuiz(quiz.id, { published: !quiz.published }),
    onSuccess: refetch,
  });
  // Every row whose toggle or delete is still in flight, not only the last one.
  const toggling = useMutationState({
    filters: { mutationKey: toggleKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as Quiz).id,
  });
  const remove = useMutation({
    mutationKey: deleteKey,
    mutationFn: (quiz: Quiz) => deleteQuiz(quiz.id),
    onSuccess: refetch,
  });
  const deleting = useMutationState({
    filters: { mutationKey: deleteKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as Quiz).id,
  });

  // A move sends the whole list in its new order; refused or not, the list
  // is read again, so it shows the server's order. One move at a time.
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderQuizzes(categoryId, ids),
    onSettled: refetch,
  });
  const move = (from: number, to: number) => {
    if (list.data && !reorder.isPending) reorder.mutate(movedIds(list.data.quizzes, from, to));
  };

  const confirmDelete = () => {
    if (toDelete) remove.mutate(toDelete);
    setToDelete(null);
  };

  const title = list.data
    ? t('admin.quizzes.title', { name: list.data.category.name })
    : t('admin.dashboard.title');

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={title} />
      <View className="mx-auto w-full max-w-2xl gap-6">
        {list.isPending ? (
          <StatusMessage text={t('admin.quizzes.loading')} />
        ) : list.isError ? (
          <ErrorState
            message={t('admin.quizzes.error')}
            retryLabel={t('admin.quizzes.retry')}
            onRetry={() => list.refetch()}
            retryDisabled={list.isFetching}
          />
        ) : list.data === null ? (
          <AdminNotFound
            message={t('admin.quizzes.notFound')}
            backLabel={t('admin.quizzes.back')}
            href="/admin/categories"
          />
        ) : (
          <>
            <Text role="heading" className="text-2xl font-bold text-gray-900">
              {title}
            </Text>
            <PrimaryLink
              label={t('admin.quizzes.create')}
              href={`/admin/categories/${categoryId}/quizzes/new`}
            />
            {toggle.isError ? (
              <ErrorText
                text={t(
                  // The database refuses to publish a quiz that breaks its rules.
                  isRuleViolation(toggle.error)
                    ? 'admin.quizzes.errors.publishRules'
                    : 'admin.quizzes.errors.toggle',
                )}
              />
            ) : null}
            {remove.isError ? <ErrorText text={t('admin.quizzes.errors.delete')} /> : null}
            {reorder.isError ? <ErrorText text={t('admin.quizzes.errors.reorder')} /> : null}
            {list.data.quizzes.length === 0 ? (
              <StatusMessage text={t('admin.quizzes.empty')} />
            ) : (
              <View className="gap-3">
                {list.data.quizzes.map((quiz, index, quizzes) => (
                  <QuizRow
                    key={quiz.id}
                    quiz={quiz}
                    index={index}
                    count={quizzes.length}
                    onMove={move}
                    toggling={toggling.includes(quiz.id)}
                    deleting={deleting.includes(quiz.id)}
                    onToggle={() => toggle.mutate(quiz)}
                    onDelete={() => setToDelete(quiz)}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </View>
      <ConfirmDialog
        visible={toDelete !== null}
        title={t('admin.quizzes.deleteDialog.title', { name: toDelete?.title ?? '' })}
        message={t('admin.quizzes.deleteDialog.message', { name: toDelete?.title ?? '' })}
        confirmLabel={t('admin.quizzes.deleteDialog.confirm')}
        cancelLabel={t('admin.quizzes.deleteDialog.cancel')}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </ScrollView>
  );
}

function QuizRow({
  quiz,
  index,
  count,
  onMove,
  toggling,
  deleting,
  onToggle,
  onDelete,
}: {
  quiz: Quiz;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  toggling: boolean;
  deleting: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const name = quiz.title;

  return (
    <View className="gap-3 rounded-xl border border-gray-200 bg-white p-4">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <RowTitle text={name} />
        <PublishedBadge
          published={quiz.published}
          label={
            quiz.published ? t('admin.quizzes.status.published') : t('admin.quizzes.status.draft')
          }
        />
      </View>
      <View className="flex-row flex-wrap gap-2">
        <MoveActions
          index={index}
          count={count}
          upLabel={t('admin.quizzes.actions.moveUp', { name })}
          downLabel={t('admin.quizzes.actions.moveDown', { name })}
          onMove={onMove}
        />
        <RowLink
          label={t('admin.quizzes.actions.questions', { name })}
          href={`/admin/quizzes/${quiz.id}`}
        />
        <RowLink
          label={t('admin.quizzes.actions.edit', { name })}
          href={`/admin/quizzes/${quiz.id}/edit`}
        />
        <RowAction
          label={
            quiz.published
              ? t('admin.quizzes.actions.unpublish', { name })
              : t('admin.quizzes.actions.publish', { name })
          }
          disabled={toggling || deleting}
          onPress={onToggle}
        />
        <RowAction
          label={t('admin.quizzes.actions.delete', { name })}
          disabled={deleting || toggling}
          onPress={onDelete}
          destructive
        />
      </View>
    </View>
  );
}
