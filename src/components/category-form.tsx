import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ErrorText } from '@/components/admin-list';
import { Button } from '@/components/status';
import { SwitchField } from '@/components/switch-field';
import { TextField } from '@/components/text-field';
import { categorySchema, type CategoryInput, type CategoryValues } from '@/lib/category-schema';

type Props = {
  initial?: { name: string; description: string | null; published: boolean };
  pending: boolean;
  failed: boolean;
  onSubmit: (values: CategoryValues) => void;
};

/**
 * The create and edit form of a category: name, description and published.
 * Validates with the shared schema before anything is sent; the input stays
 * when saving fails.
 */
export function CategoryForm({ initial, pending, failed, onSubmit }: Props) {
  const { t } = useTranslation();
  const { control, handleSubmit, formState } = useForm<CategoryInput, unknown, CategoryValues>({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: initial?.name ?? '',
      description: initial?.description ?? '',
      published: initial?.published ?? false,
    },
  });
  const nameError = formState.errors.name?.message;

  const submit = handleSubmit((values) => {
    if (!pending) onSubmit(values);
  });

  return (
    <View className="gap-4">
      <Controller
        control={control}
        name="name"
        render={({ field }) => (
          <TextField
            id="category-name"
            label={t('admin.categories.form.name')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
          />
        )}
      />
      {nameError ? (
        // The schema's messages are keys of admin.categories.form.errors.
        <ErrorText text={t(nameError as 'admin.categories.form.errors.nameRequired')} />
      ) : null}
      <Controller
        control={control}
        name="description"
        render={({ field }) => (
          <TextField
            id="category-description"
            label={t('admin.categories.form.description')}
            value={field.value ?? ''}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            multiline
          />
        )}
      />
      <Controller
        control={control}
        name="published"
        render={({ field }) => (
          <SwitchField
            label={t('admin.categories.form.published')}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      {failed ? <ErrorText text={t('admin.categories.form.errors.save')} /> : null}
      <Button
        label={pending ? t('admin.categories.form.saving') : t('admin.categories.form.save')}
        disabled={pending}
        onPress={() => void submit()}
      />
    </View>
  );
}
