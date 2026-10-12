import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageTitle } from '@/components/page-title';
import { ErrorState, StatusMessage } from '@/components/status';
import {
  adminCategoriesKey,
  deleteCategory,
  fetchAdminCategories,
  updateCategory,
} from '@/lib/admin-categories';

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
        <Link href="/admin/categories/new" asChild>
          <Pressable role="link" className="items-center rounded-lg bg-blue-700 px-4 py-3">
            <Text className="text-base font-semibold text-white">
              {t('admin.categories.create')}
            </Text>
          </Pressable>
        </Link>
        {toggle.isError ? <ErrorText text={t('admin.categories.errors.toggle')} /> : null}
        {remove.isError ? <ErrorText text={t('admin.categories.errors.delete')} /> : null}
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
            {categories.data.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
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
  toggling,
  deleting,
  onToggle,
  onDelete,
}: {
  category: Category;
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
        <Text className="text-lg font-semibold text-gray-900">{name}</Text>
        <Text
          className={`rounded-full px-3 py-1 text-sm font-semibold ${
            category.published ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-800'
          }`}
        >
          {category.published
            ? t('admin.categories.status.published')
            : t('admin.categories.status.draft')}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Link href={`/admin/categories/${category.id}`} asChild>
          <Pressable
            role="link"
            aria-label={t('admin.categories.actions.edit', { name })}
            className="rounded-lg border border-gray-500 px-3 py-2"
          >
            <Text className="text-base text-gray-900">
              {t('admin.categories.actions.edit', { name })}
            </Text>
          </Pressable>
        </Link>
        <RowAction
          label={
            category.published
              ? t('admin.categories.actions.unpublish', { name })
              : t('admin.categories.actions.publish', { name })
          }
          disabled={toggling || deleting}
          onPress={onToggle}
        />
        <RowAction
          label={t('admin.categories.actions.delete', { name })}
          disabled={deleting}
          onPress={onDelete}
          destructive
        />
      </View>
    </View>
  );
}

function RowAction({
  label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-lg border px-3 py-2 ${destructive ? 'border-red-700' : 'border-gray-500'}`}
    >
      <Text className={`text-base ${destructive ? 'text-red-700' : 'text-gray-900'}`}>{label}</Text>
    </Pressable>
  );
}

function ErrorText({ text }: { text: string }) {
  return (
    <Text role="alert" className="text-base text-red-700">
      {text}
    </Text>
  );
}
