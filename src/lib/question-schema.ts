import { z } from 'zod';

import { optionalText, requiredText } from '@/lib/text-schema';

/**
 * What the admin may write for a question: text, explanation and
 * multiple_correct. The quiz comes from the route, sort_order, id and
 * created_at from the database; images are item 5. A blank explanation is
 * stored as null. Messages are i18next keys.
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

/**
 * One answer as the admin writes it: an existing answer keeps its id, a new
 * one has null. sort_order, images and question_id come from the database.
 */
const answerSchema = z.object({
  id: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  text: requiredText(ANSWER_ERRORS.textRequired),
  is_correct: z.boolean(),
});

/**
 * A question with its answers, as save_question() takes it. Mirrors the
 * database's rules (question_rules.test.sql): at least two answers, at least
 * one correct, exactly one for single choice, no blank answer text. The
 * answer rules report on `answers`, a blank text on `answers.<index>.text`.
 */
export const questionWithAnswersSchema = questionSchema
  .extend({ answers: z.array(answerSchema) })
  .superRefine((question, context) => {
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
  });

export type QuestionWithAnswersValues = z.output<typeof questionWithAnswersSchema>;

/** What the form holds before validation. */
export type QuestionWithAnswersInput = z.input<typeof questionWithAnswersSchema>;
