import { z } from 'zod';

import { isImageType, MAX_IMAGE_BYTES } from '@/lib/images';
import { isBlank, optionalText, requiredText } from '@/lib/text-schema';

/**
 * What the admin may write for a question: text, explanation and
 * multiple_correct. The quiz comes from the route, sort_order, id and
 * created_at from the database; the images come with its answers below. A
 * blank explanation is stored as null. Messages are i18next keys.
 */
export const questionSchema = z.object({
  text: requiredText('admin.questions.form.errors.textRequired'),
  explanation: optionalText(),
  multiple_correct: z.boolean(),
});

export type QuestionValues = z.output<typeof questionSchema>;

/** What the form holds before validation. */
export type QuestionInput = z.input<typeof questionSchema>;

const ANSWER_ERRORS = {
  tooFew: 'admin.questions.form.errors.answersTooFew',
  correctMissing: 'admin.questions.form.errors.correctMissing',
  singleChoice: 'admin.questions.form.errors.singleChoiceOneCorrect',
  textRequired: 'admin.questions.form.errors.answerTextRequired',
} as const;

const IMAGE_ERRORS = {
  altRequired: 'admin.questions.form.errors.imageAltRequired',
  tooLarge: 'admin.questions.form.errors.imageTooLarge',
  type: 'admin.questions.form.errors.imageType',
} as const;

/**
 * A newly picked file, not yet uploaded, within the bucket's limits: png,
 * jpeg or webp and at most 5 MiB. A size the picker doesn't know is left to
 * the bucket's own limit at upload.
 */
export const imageFileSchema = z
  .object({ uri: z.string(), mimeType: z.string(), size: z.number().optional() })
  .superRefine((file, context) => {
    if (!isImageType(file.mimeType)) {
      context.addIssue({ code: 'custom', message: IMAGE_ERRORS.type });
    }
    if (file.size !== undefined && file.size > MAX_IMAGE_BYTES) {
      context.addIssue({ code: 'custom', message: IMAGE_ERRORS.tooLarge });
    }
  });

export type ImageFile = z.output<typeof imageFileSchema>;

/**
 * The image of a question or an answer: the object name in quiz-images
 * (image_path, chosen by the app when a file is picked), its alt text and the
 * picked file still to upload. Missing fields mean no image. The database
 * checks the name; the alt text is required with an image, as there.
 */
const imageFields = {
  image_path: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  image_alt: z.string().nullish(),
  image_file: imageFileSchema.nullish().transform((value) => value ?? null),
};

type Image = { image_path: string | null; image_alt?: string | null };

function checkImageAlt(image: Image, context: z.RefinementCtx) {
  if (image.image_path !== null && (image.image_alt == null || isBlank(image.image_alt))) {
    context.addIssue({ code: 'custom', path: ['image_alt'], message: IMAGE_ERRORS.altRequired });
  }
}

// Without an image no alt text is stored.
const storeImageAlt = <T extends Image>(image: T) => ({
  ...image,
  image_alt: image.image_path === null ? null : (image.image_alt ?? null),
});

/**
 * One answer as the admin writes it: an existing answer keeps its id, a new
 * one has null. sort_order and question_id come from the database.
 */
const answerSchema = z
  .object({
    id: z
      .string()
      .nullish()
      .transform((value) => value ?? null),
    text: requiredText(ANSWER_ERRORS.textRequired),
    is_correct: z.boolean(),
    ...imageFields,
  })
  .superRefine(checkImageAlt)
  .transform(storeImageAlt);

/**
 * A question with its answers, as save_question() takes it. Mirrors the
 * database's rules (question_rules.test.sql): at least two answers, at least
 * one correct, exactly one for single choice, no blank answer text, an alt
 * text with every image. The answer rules report on `answers`, a blank text
 * on `answers.<index>.text`, an image on its `image_alt` or `image_file`.
 */
export const questionWithAnswersSchema = questionSchema
  .extend({ ...imageFields, answers: z.array(answerSchema) })
  .superRefine((question, context) => {
    checkImageAlt(question, context);
    const correct = question.answers.filter((answer) => answer.is_correct).length;
    const message =
      question.answers.length < 2
        ? ANSWER_ERRORS.tooFew
        : correct === 0
          ? ANSWER_ERRORS.correctMissing
          : !question.multiple_correct && correct > 1
            ? ANSWER_ERRORS.singleChoice
            : null;
    if (message) context.addIssue({ code: 'custom', path: ['answers'], message });
  })
  .transform(storeImageAlt);

export type QuestionWithAnswersValues = z.output<typeof questionWithAnswersSchema>;

/** What the form holds before validation. */
export type QuestionWithAnswersInput = z.input<typeof questionWithAnswersSchema>;
