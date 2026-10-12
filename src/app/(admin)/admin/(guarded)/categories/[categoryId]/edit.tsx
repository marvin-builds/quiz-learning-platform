import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AdminNotFound } from '@/components/admin-list';
import { CategoryForm } from '@/components/category-form';
import { FormScreen } from '@/components/form-screen';
import { ErrorState, StatusMessage } from '@/components/status';
import {
  adminCategoriesKey,
  adminCategoryKey,
  fetchAdminCategory,
  updateCategory,
} from '@/lib/admin-categories';
import type { CategoryValues } from '@/lib/category-schema';

export default function EditCategoryScreen() {
  const { t } = useTranslation();
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const queryClient = useQueryClient();
  const category = useQuery({
    queryKey: adminCategoryKey(categoryId),
    queryFn: () => fetchAdminCategory(categoryId),
    // The admin is waiting to edit: show the error and its retry at once
    // rather than after the default retries with backoff.
    retry: false,
    // The form takes its values once, when it mounts, so it must never mount
    // with a cached row that a publish or delete on the list has outdated:
    // drop the row when the form closes and read it again on every visit.
    gcTime: 0,
  });
  const update = useMutation({
    mutationFn: (values: CategoryValues) => updateCategory(categoryId, values),
    onSuccess: async () => {
      // Covers the list and this category.
      await queryClient.invalidateQueries({ queryKey: adminCategoriesKey });
      router.replace('/admin/categories');
    },
  });

  return (
    <FormScreen title={t('admin.categories.form.editTitle')}>
      {category.isPending ? (
        <StatusMessage text={t('admin.categories.form.loading')} />
      ) : category.isError ? (
        <ErrorState
          message={t('admin.categories.form.errors.load')}
          retryLabel={t('admin.categories.retry')}
          onRetry={() => category.refetch()}
          retryDisabled={category.isFetching}
        />
      ) : category.data === null ? (
        <AdminNotFound
          message={t('admin.categories.form.notFound')}
          backLabel={t('admin.categories.form.back')}
          href="/admin/categories"
        />
      ) : (
        <CategoryForm
          initial={category.data}
          pending={update.isPending}
          failed={update.isError}
          onSubmit={(values) => update.mutate(values)}
        />
      )}
    </FormScreen>
  );
}
