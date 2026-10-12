import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { CategoryForm } from '@/components/category-form';
import { CategoryFormScreen } from '@/components/category-form-screen';
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
    <CategoryFormScreen title={t('admin.categories.form.editTitle')}>
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
        <View className="items-center">
          <StatusMessage text={t('admin.categories.form.notFound')} />
          <Link href="/admin/categories" asChild>
            <Pressable role="link">
              <Text className="text-base font-semibold text-blue-700 underline">
                {t('admin.categories.form.back')}
              </Text>
            </Pressable>
          </Link>
        </View>
      ) : (
        <CategoryForm
          initial={category.data}
          pending={update.isPending}
          failed={update.isError}
          onSubmit={(values) => update.mutate(values)}
        />
      )}
    </CategoryFormScreen>
  );
}
