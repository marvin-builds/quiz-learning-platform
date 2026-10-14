import { optionalText, requiredText } from '@/lib/text-schema';
import { z } from '@/lib/zod';

/**
 * What the admin may write for a category: name, description and published,
 * nothing else (the database assigns sort_order, id and created_at). A blank
 * description is stored as null. Messages are i18next keys.
 */
export const categorySchema = z.object({
  name: requiredText('admin.categories.form.errors.nameRequired'),
  description: optionalText(),
  published: z.boolean(),
});

export type CategoryValues = z.output<typeof categorySchema>;

/** What the form holds before validation. */
export type CategoryInput = z.input<typeof categorySchema>;
