import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useFormChanged } from '@/components/admin-header';
import { ErrorText } from '@/components/admin-list';
import { Button } from '@/components/status';
import { SwitchField } from '@/components/switch-field';
import { TextField } from '@/components/text-field';
import { quizSchema, type QuizInput, type QuizValues } from '@/lib/quiz-schema';

type Props = {
  initial?: { title: string; description: string | null; published: boolean };
  pending: boolean;
  /** The translated message of a failed save, or null. */
  failure: string | null;
  onSubmit: (values: QuizValues) => void;
};

/**
 * The create and edit form of a quiz: title, description and published.
 * Validates with the shared schema before anything is sent; the input stays
 * when saving fails.
 */
export function QuizForm({ initial, pending, failure, onSubmit }: Props) {
  const { t } = useTranslation();
  const { control, handleSubmit, formState } = useForm<QuizInput, unknown, QuizValues>({
    resolver: zodResolver(quizSchema),
    defaultValues: {
      title: initial?.title ?? '',
      description: initial?.description ?? '',
      published: initial?.published ?? false,
    },
  });
  const titleError = formState.errors.title?.message;
  // Leaving through the header or breadcrumb asks while the input differs from the loaded values.
  useFormChanged(formState.isDirty);

  const submit = handleSubmit((values) => {
    if (!pending) onSubmit(values);
  });

  return (
    <View className="gap-4">
      <Controller
        control={control}
        name="title"
        render={({ field }) => (
          <TextField
            id="quiz-title"
            label={t('admin.quizzes.form.title')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
          />
        )}
      />
      {titleError ? (
        // The schema's messages are keys of admin.quizzes.form.errors.
        <ErrorText text={t(titleError as 'admin.quizzes.form.errors.titleRequired')} />
      ) : null}
      <Controller
        control={control}
        name="description"
        render={({ field }) => (
          <TextField
            id="quiz-description"
            label={t('admin.quizzes.form.description')}
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
            label={t('admin.quizzes.form.published')}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      {failure ? <ErrorText text={failure} /> : null}
      <Button
        label={pending ? t('admin.quizzes.form.saving') : t('admin.quizzes.form.save')}
        disabled={pending}
        onPress={() => void submit()}
      />
    </View>
  );
}
