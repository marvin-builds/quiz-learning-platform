import { optionalText, requiredText } from '@/lib/text-schema';
import { z } from '@/lib/zod';

/**
 * What the admin may write for a quiz: title, description and published. The
 * category comes from the route, sort_order, id and created_at from the
 * database. A blank description is stored as null. Messages are i18next keys.
 */
export const quizSchema = z.object({
  title: requiredText('admin.quizzes.form.errors.titleRequired'),
  description: optionalText(),
  published: z.boolean(),
});

export type QuizValues = z.output<typeof quizSchema>;

/** What the form holds before validation. */
export type QuizInput = z.input<typeof quizSchema>;
