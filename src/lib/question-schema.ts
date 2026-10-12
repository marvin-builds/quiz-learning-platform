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
