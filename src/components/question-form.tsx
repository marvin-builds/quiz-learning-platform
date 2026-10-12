import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ErrorText } from '@/components/admin-list';
import { Button } from '@/components/status';
import { SwitchField } from '@/components/switch-field';
import { TextField } from '@/components/text-field';
import { questionSchema, type QuestionInput, type QuestionValues } from '@/lib/question-schema';

type Props = {
  initial?: { text: string; explanation: string | null; multiple_correct: boolean };
  pending: boolean;
  failed: boolean;
  onSubmit: (values: QuestionValues) => void;
};

/**
 * The create and edit form of a question: text, explanation and multiple_correct.
 * Validates with the shared schema before anything is sent; the input stays
 * when saving fails.
 */
export function QuestionForm({ initial, pending, failed, onSubmit }: Props) {
  const { t } = useTranslation();
  const { control, handleSubmit, formState } = useForm<QuestionInput, unknown, QuestionValues>({
    resolver: zodResolver(questionSchema),
    defaultValues: {
      text: initial?.text ?? '',
      explanation: initial?.explanation ?? '',
      multiple_correct: initial?.multiple_correct ?? false,
    },
  });
  const textError = formState.errors.text?.message;

  const submit = handleSubmit((values) => {
    if (!pending) onSubmit(values);
  });

  return (
    <View className="gap-4">
      <Controller
        control={control}
        name="text"
        render={({ field }) => (
          <TextField
            id="question-text"
            label={t('admin.questions.form.text')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            multiline
          />
        )}
      />
      {textError ? (
        // The schema's messages are keys of admin.questions.form.errors.
        <ErrorText text={t(textError as 'admin.questions.form.errors.textRequired')} />
      ) : null}
      <Controller
        control={control}
        name="explanation"
        render={({ field }) => (
          <TextField
            id="question-explanation"
            label={t('admin.questions.form.explanation')}
            value={field.value ?? ''}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            multiline
          />
        )}
      />
      <Controller
        control={control}
        name="multiple_correct"
        render={({ field }) => (
          <SwitchField
            label={t('admin.questions.form.multipleCorrect')}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      {failed ? <ErrorText text={t('admin.questions.form.errors.save')} /> : null}
      <Button
        label={pending ? t('admin.questions.form.saving') : t('admin.questions.form.save')}
        disabled={pending}
        onPress={() => void submit()}
      />
    </View>
  );
}
