import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';

import {
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
  adminCategoriesKey,
  deleteCategory,
  fetchAdminCategories,
  reorderCategories,
  updateCategory,
} from '@/lib/admin-categories';
import { movedIds } from '@/lib/admin-rows';

type Category = Awaited<ReturnType<typeof fetchAdminCategories>>[number];

const toggleKey = [...adminCategoriesKey, 'toggle'] as const;
const deleteKey = [...adminCategoriesKey, 'delete'] as const;

export default function AdminCategoriesScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: adminCategoriesKey, queryFn: fetchAdminCategories });
  const [toDelete, setToDelete] = useState<Category | null>(null);

  // Every successful write reads the list from the server again.
  const refetch = () => queryClient.invalidateQueries({ queryKey: adminCategoriesKey });
  const toggle = useMutation({
    mutationKey: toggleKey,
    mutationFn: (category: Category) =>
      updateCategory(category.id, { published: !category.published }),
    onSuccess: refetch,
  });
  // Every row whose toggle is still in flight, not only the last one toggled.
  const toggling = useMutationState({
    filters: { mutationKey: toggleKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as Category).id,
  });
  const remove = useMutation({
    mutationKey: deleteKey,
    mutationFn: (category: Category) => deleteCategory(category.id),
    onSuccess: refetch,
  });
  // Rows whose delete is still in flight: a second delete would find no row.
  const deleting = useMutationState({
    filters: { mutationKey: deleteKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as Category).id,
  });

  // A move sends the whole list in its new order; refused or not, the list
  // is read again, so it shows the server's order. One move at a time.
  const reorder = useMutation({ mutationFn: reorderCategories, onSettled: refetch });
  const move = (from: number, to: number) => {
    if (categories.data && !reorder.isPending) {
      reorder.mutate(movedIds(categories.data, from, to));
    }
  };

  const confirmDelete = () => {
    if (toDelete) remove.mutate(toDelete);
    setToDelete(null);
  };

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={t('admin.categories.title')} />
      <View className="mx-auto w-full max-w-2xl gap-6">
        <Text role="heading" className="text-2xl font-bold text-gray-900">
          {t('admin.categories.title')}
        </Text>
        <PrimaryLink label={t('admin.categories.create')} href="/admin/categories/new" />
        {toggle.isError ? <ErrorText text={t('admin.categories.errors.toggle')} /> : null}
        {remove.isError ? <ErrorText text={t('admin.categories.errors.delete')} /> : null}
        {reorder.isError ? <ErrorText text={t('admin.categories.errors.reorder')} /> : null}
        {categories.isPending ? (
          <StatusMessage text={t('admin.categories.loading')} />
        ) : categories.isError ? (
          <ErrorState
            message={t('admin.categories.error')}
            retryLabel={t('admin.categories.retry')}
            onRetry={() => categories.refetch()}
            retryDisabled={categories.isFetching}
          />
        ) : categories.data.length === 0 ? (
          <StatusMessage text={t('admin.categories.empty')} />
        ) : (
          <View className="gap-3">
            {categories.data.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                index={index}
                count={categories.data.length}
                onMove={move}
                toggling={toggling.includes(category.id)}
                deleting={deleting.includes(category.id)}
                onToggle={() => toggle.mutate(category)}
                onDelete={() => setToDelete(category)}
              />
            ))}
          </View>
        )}
      </View>
      <ConfirmDialog
        visible={toDelete !== null}
        title={t('admin.categories.deleteDialog.title', { name: toDelete?.name ?? '' })}
        message={t('admin.categories.deleteDialog.message', { name: toDelete?.name ?? '' })}
        confirmLabel={t('admin.categories.deleteDialog.confirm')}
        cancelLabel={t('admin.categories.deleteDialog.cancel')}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </ScrollView>
  );
}

function CategoryRow({
  category,
  index,
  count,
  onMove,
  toggling,
  deleting,
  onToggle,
  onDelete,
}: {
  category: Category;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  toggling: boolean;
  deleting: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const name = category.name;

  return (
    <View className="gap-3 rounded-xl border border-gray-200 bg-white p-4">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <RowTitle text={name} />
        <PublishedBadge
          published={category.published}
          label={
            category.published
              ? t('admin.categories.status.published')
              : t('admin.categories.status.draft')
          }
        />
      </View>
      <View className="flex-row flex-wrap gap-2">
        <RowLink
          label={t('admin.rowActions.quizzes')}
          name={t('admin.categories.actions.quizzes', { name })}
          href={`/admin/categories/${category.id}`}
        />
        <RowLink
          label={t('admin.rowActions.edit')}
          name={t('admin.categories.actions.edit', { name })}
          href={`/admin/categories/${category.id}/edit`}
        />
        <RowAction
          label={
            category.published ? t('admin.rowActions.unpublish') : t('admin.rowActions.publish')
          }
          name={
            category.published
              ? t('admin.categories.actions.unpublish', { name })
              : t('admin.categories.actions.publish', { name })
          }
          disabled={toggling || deleting}
          onPress={onToggle}
        />
        <MoveActions
          index={index}
          count={count}
          upName={t('admin.categories.actions.moveUp', { name })}
          downName={t('admin.categories.actions.moveDown', { name })}
          onMove={onMove}
        />
        <RowAction
          label={t('admin.rowActions.delete')}
          name={t('admin.categories.actions.delete', { name })}
          disabled={deleting}
          onPress={onDelete}
          destructive
        />
      </View>
    </View>
  );
}
