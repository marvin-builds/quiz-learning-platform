import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { Button } from '@/components/status';
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
        <Text role="alert" className="text-base text-red-700">
          {t(nameError as 'admin.categories.form.errors.nameRequired')}
        </Text>
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
          <PublishedSwitch
            label={t('admin.categories.form.published')}
            published={field.value}
            onChange={field.onChange}
          />
        )}
      />
      {failed ? (
        <Text role="alert" className="text-base text-red-700">
          {t('admin.categories.form.errors.save')}
        </Text>
      ) : null}
      <Button
        label={pending ? t('admin.categories.form.saving') : t('admin.categories.form.save')}
        disabled={pending}
        onPress={() => void submit()}
      />
    </View>
  );
}

function PublishedSwitch({
  label,
  published,
  onChange,
}: {
  label: string;
  published: boolean;
  onChange: (published: boolean) => void;
}) {
  return (
    <Pressable
      role="switch"
      aria-checked={published}
      aria-label={label}
      onPress={() => onChange(!published)}
      className="flex-row items-center justify-between rounded-lg border border-gray-500 bg-white px-3 py-3"
    >
      <Text className="text-base font-semibold text-gray-900">{label}</Text>
      <View
        className={`h-7 w-12 justify-center rounded-full px-1 ${
          published ? 'items-end bg-blue-700' : 'items-start bg-gray-400'
        }`}
      >
        <View className="h-5 w-5 rounded-full bg-white" />
      </View>
    </Pressable>
  );
}
