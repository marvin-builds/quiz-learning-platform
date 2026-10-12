import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { CategoryFormScreen } from '@/components/category-form-screen';
import { CategoryForm } from '@/components/category-form';
import { adminCategoriesKey, createCategory } from '@/lib/admin-categories';

export default function NewCategoryScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createCategory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminCategoriesKey });
      router.replace('/admin/categories');
    },
  });

  return (
    <CategoryFormScreen title={t('admin.categories.form.createTitle')}>
      <CategoryForm
        pending={create.isPending}
        failed={create.isError}
        onSubmit={(values) => create.mutate(values)}
      />
    </CategoryFormScreen>
  );
}
