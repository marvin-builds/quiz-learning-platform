import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { Button } from '@/components/status';
import { TextField } from '@/components/text-field';
import { categorySchema, type CategoryValues } from '@/lib/category-schema';

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
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [published, setPublished] = useState(initial?.published ?? false);
  const [nameError, setNameError] = useState<string | null>(null);

  const submit = () => {
    if (pending) return;
    const result = categorySchema.safeParse({ name, description, published });
    if (!result.success) {
      const issue = result.error.issues.find((candidate) => candidate.path[0] === 'name');
      setNameError(issue?.message ?? null);
      return;
    }
    setNameError(null);
    onSubmit(result.data);
  };

  return (
    <View className="gap-4">
      <TextField
        id="category-name"
        label={t('admin.categories.form.name')}
        value={name}
        onChangeText={setName}
      />
      {nameError ? (
        // The schema's messages are keys of admin.categories.form.errors.
        <Text role="alert" className="text-base text-red-700">
          {t(nameError as 'admin.categories.form.errors.nameRequired')}
        </Text>
      ) : null}
      <TextField
        id="category-description"
        label={t('admin.categories.form.description')}
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <Pressable
        role="switch"
        aria-checked={published}
        aria-label={t('admin.categories.form.published')}
        onPress={() => setPublished(!published)}
        className="flex-row items-center justify-between rounded-lg border border-gray-500 bg-white px-3 py-3"
      >
        <Text className="text-base font-semibold text-gray-900">
          {t('admin.categories.form.published')}
        </Text>
        <View
          className={`h-7 w-12 justify-center rounded-full px-1 ${
            published ? 'items-end bg-blue-700' : 'items-start bg-gray-400'
          }`}
        >
          <View className="h-5 w-5 rounded-full bg-white" />
        </View>
      </Pressable>
      {failed ? (
        <Text role="alert" className="text-base text-red-700">
          {t('admin.categories.form.errors.save')}
        </Text>
      ) : null}
      <Button
        label={pending ? t('admin.categories.form.saving') : t('admin.categories.form.save')}
        disabled={pending}
        onPress={submit}
      />
    </View>
  );
}
