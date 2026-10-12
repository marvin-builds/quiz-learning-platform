import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ErrorText, RowAction } from '@/components/admin-list';
import { CheckboxField } from '@/components/checkbox-field';
import { ImageField } from '@/components/image-field';
import { Button } from '@/components/status';
import { SwitchField } from '@/components/switch-field';
import { TextField } from '@/components/text-field';
import {
  type ImageFile,
  questionWithAnswersSchema,
  type QuestionWithAnswersInput,
  type QuestionWithAnswersValues,
} from '@/lib/question-schema';

type Image = { image_path?: string | null; image_alt?: string | null };

type Answer = { id: string | null; text: string; is_correct: boolean } & Image;

type Props = {
  initial?: {
    text: string;
    explanation: string | null;
    multiple_correct: boolean;
    answers: Answer[];
  } & Image;
  pending: boolean;
  /** The translated message of a failed save, or null. */
  failure: string | null;
  onSubmit: (values: QuestionWithAnswersValues) => void;
};

const NO_IMAGE = { image_path: null, image_alt: null, image_file: null };

const EMPTY_ANSWER = { id: null, text: '', is_correct: false, ...NO_IMAGE };

// The schema's messages are keys of admin.questions.form.errors.
type ErrorKey = `admin.questions.form.errors.${
  | 'textRequired'
  | 'answersTooFew'
  | 'correctMissing'
  | 'singleChoiceOneCorrect'
  | 'answerTextRequired'
  | 'imageAltRequired'}`;

/**
 * The create and edit form of a question: text, explanation, multiple_correct,
 * its image and its answers inline (add, edit, remove, mark correct, image).
 * A picked image's file comes with the values, for the screen to upload.
 * Validates with the shared schema before anything is sent and shows the
 * answer rules next to the answers; the input stays when saving fails.
 */
export function QuestionForm({ initial, pending, failure, onSubmit }: Props) {
  const { t } = useTranslation();
  const { control, handleSubmit, formState, trigger, setValue } = useForm<
    QuestionWithAnswersInput,
    unknown,
    QuestionWithAnswersValues
  >({
    resolver: zodResolver(questionWithAnswersSchema),
    defaultValues: {
      text: initial?.text ?? '',
      explanation: initial?.explanation ?? '',
      multiple_correct: initial?.multiple_correct ?? false,
      image_path: initial?.image_path ?? null,
      image_alt: initial?.image_alt ?? null,
      image_file: null,
      answers: initial?.answers.map((answer) => ({ ...NO_IMAGE, ...answer })) ?? [
        EMPTY_ANSWER,
        EMPTY_ANSWER,
      ],
    },
  });
  const values = useWatch({ control });
  // keyName: the answers have an `id` of their own.
  const answers = useFieldArray({ control, name: 'answers', keyName: 'key' });
  const { errors } = formState;
  const textError = errors.text?.message;
  const answersError = errors.answers?.root?.message ?? errors.answers?.message;

  const submit = handleSubmit((valid) => {
    if (!pending) onSubmit(valid);
  });

  // The image fields of the question (prefix '') or of answer `answers.<i>.`.
  type WatchedImage = {
    image_path?: string | null;
    image_alt?: string | null;
    image_file?: Partial<ImageFile> | null;
  };
  const imageProps = (prefix: '' | `answers.${number}.`, image: WatchedImage | undefined) => ({
    path: image?.image_path ?? null,
    file: (image?.image_file as ImageFile | null | undefined) ?? null,
    alt: image?.image_alt ?? null,
    onPicked: (path: string, file: ImageFile) => {
      setValue(`${prefix}image_path`, path);
      setValue(`${prefix}image_file`, file);
    },
    // The alt text check reports on image_alt: after a save attempt, check
    // it again when the image or its alt text changes, so no outdated
    // message stays.
    onRemove: () => {
      setValue(`${prefix}image_path`, null);
      setValue(`${prefix}image_file`, null);
      setValue(`${prefix}image_alt`, null, { shouldValidate: formState.isSubmitted });
    },
    onAltChange: (alt: string) =>
      setValue(`${prefix}image_alt`, alt, { shouldValidate: formState.isSubmitted }),
  });
  const errorText = (message: string | undefined) => (message ? t(message as ErrorKey) : undefined);

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
      {textError ? <ErrorText text={t(textError as ErrorKey)} /> : null}
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
            onChange={(value) => {
              field.onChange(value);
              // The single-choice rule reports on `answers`: after a save
              // attempt, check it again so no outdated message stays.
              if (formState.isSubmitted) void trigger('answers');
            }}
          />
        )}
      />
      <ImageField
        id="question-image-alt"
        labels={{
          pick: t('admin.questions.form.image.pick'),
          replace: t('admin.questions.form.image.replace'),
          remove: t('admin.questions.form.image.remove'),
          alt: t('admin.questions.form.image.alt'),
          preview: t('admin.questions.form.image.preview'),
        }}
        {...imageProps('', values)}
        altError={errorText(errors.image_alt?.message)}
      />
      <View className="gap-3">
        <Text role="heading" aria-level={2} className="text-lg font-semibold text-gray-900">
          {t('admin.questions.form.answers.title')}
        </Text>
        {answers.fields.map((answer, index) => {
          const number = String(index + 1);
          const answerTextError = errors.answers?.[index]?.text?.message;
          return (
            <View key={answer.key} className="gap-1 rounded-lg border border-gray-200 bg-white p-3">
              <Controller
                control={control}
                name={`answers.${index}.text`}
                render={({ field }) => (
                  <TextField
                    id={`answer-text-${answer.key}`}
                    label={t('admin.questions.form.answers.text', { number })}
                    value={field.value ?? ''}
                    onChangeText={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
              {answerTextError ? <ErrorText text={t(answerTextError as ErrorKey)} /> : null}
              <ImageField
                id={`answer-image-alt-${answer.key}`}
                labels={{
                  pick: t('admin.questions.form.answers.image.pick', { number }),
                  replace: t('admin.questions.form.answers.image.replace', { number }),
                  remove: t('admin.questions.form.answers.image.remove', { number }),
                  alt: t('admin.questions.form.answers.image.alt', { number }),
                  preview: t('admin.questions.form.answers.image.preview', { number }),
                }}
                {...imageProps(`answers.${index}.`, values.answers?.[index])}
                altError={errorText(errors.answers?.[index]?.image_alt?.message)}
              />
              <View className="flex-row flex-wrap items-center justify-between gap-2">
                <Controller
                  control={control}
                  name={`answers.${index}.is_correct`}
                  render={({ field }) => (
                    <CheckboxField
                      label={t('admin.questions.form.answers.correct', { number })}
                      value={field.value}
                      onChange={(value) => {
                        field.onChange(value);
                        // The answer rules report on `answers`, which a
                        // change of one mark doesn't revalidate by itself:
                        // after a save attempt, check them again so no
                        // outdated message stays.
                        if (formState.isSubmitted) void trigger('answers');
                      }}
                    />
                  )}
                />
                <RowAction
                  label={t('admin.questions.form.answers.remove', { number })}
                  onPress={() => answers.remove(index)}
                  destructive
                />
              </View>
            </View>
          );
        })}
        {answersError ? <ErrorText text={t(answersError as ErrorKey)} /> : null}
        <RowAction
          label={t('admin.questions.form.answers.add')}
          onPress={() => answers.append(EMPTY_ANSWER)}
        />
      </View>
      {failure ? <ErrorText text={failure} /> : null}
      <Button
        label={pending ? t('admin.questions.form.saving') : t('admin.questions.form.save')}
        disabled={pending}
        onPress={() => void submit()}
      />
    </View>
  );
}
