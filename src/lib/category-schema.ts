import { z } from 'zod';

// The database's rule for names (categories_name_check): not empty once
// spaces, tabs and line breaks are trimmed. The schema must never be looser.
const BLANK = /^[ \t\r\n]*$/;

const NAME_REQUIRED = 'admin.categories.form.errors.nameRequired';

/**
 * What the admin may write for a category: name, description and published,
 * nothing else (the database assigns sort_order, id and created_at). A blank
 * description is stored as null. Messages are i18next keys.
 */
export const categorySchema = z.object({
  name: z.string({ error: NAME_REQUIRED }).refine((name) => !BLANK.test(name), NAME_REQUIRED),
  description: z
    .string()
    .nullish()
    .transform((description) =>
      description == null || BLANK.test(description) ? null : description,
    ),
  published: z.boolean(),
});

export type CategoryValues = z.output<typeof categorySchema>;
