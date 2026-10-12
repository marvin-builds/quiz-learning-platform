import { z } from 'zod';

// The database's rule for names, titles and texts (the *_check constraints):
// not empty once spaces, tabs and line breaks are trimmed. A schema must
// never be looser.
const BLANK = /^[ \t\r\n]*$/;

/** Whether a text is empty once spaces, tabs and line breaks are trimmed. */
export const isBlank = (value: string) => BLANK.test(value);

/** A required text; `message` (an i18next key) for a missing or blank one. */
export const requiredText = (message: string) =>
  z.string({ error: message }).refine((value) => !BLANK.test(value), message);

/** An optional text, stored as null when it is missing or blank. */
export const optionalText = () =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null || BLANK.test(value) ? null : value));
