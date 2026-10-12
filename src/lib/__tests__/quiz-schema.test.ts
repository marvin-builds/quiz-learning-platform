import * as fc from 'fast-check';

import i18n from '@/i18n';
import { quizSchema } from '@/lib/quiz-schema';
import type { TablesInsert, TablesUpdate } from '@/types/database';

// The quiz form's zod schema (#81): what the admin may send for a quiz, and
// nothing more. The database checks the same rules again (the title must not
// be blank once ' \t\r\n' are trimmed); the schema must never be looser, so a
// title the form accepts is one the database accepts too. A description that
// is empty after trimming is stored as null. The category comes from the
// route, not the form, and sort_order from the database. Validation messages
// are i18next keys, which the form translates.

type QuizValues = ReturnType<typeof quizSchema.parse>;

// The parsed values are what the client may write: they fit the generated
// insert and update types (insert without sort_order, which the database
// assigns, and without category_id, which the screen adds) and hold only the
// columns the admin may write. Compile-time checks; `npm run typecheck` fails
// when they don't hold.
type Writable = Pick<TablesInsert<'quizzes'>, 'title' | 'description' | 'published'>;
const fitsInsert = (values: QuizValues): Writable => values;
const fitsInsertWithCategory = (
  values: QuizValues,
  categoryId: string,
): Omit<TablesInsert<'quizzes'>, 'sort_order'> => ({ ...values, category_id: categoryId });
const fitsUpdate = (values: QuizValues): TablesUpdate<'quizzes'> => values;

// The database's rule: btrim(title, E' \t\r\n') is not empty.
const databaseAcceptsTitle = (title: string) =>
  title.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') !== '';

const blank = fc
  .array(fc.constantFrom(' ', '\t', '\r', '\n'), { maxLength: 12 })
  .map((parts) => parts.join(''));

function titleIssues(input: unknown) {
  const result = quizSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.filter((issue) => issue.path[0] === 'title');
}

describe('quizSchema', () => {
  it('accepts a title, a description and the published flag', () => {
    const values = quizSchema.parse({
      title: 'Hauptstädte Europas',
      description: 'Kennst du die Hauptstädte?',
      published: true,
    });

    expect(fitsInsert(values)).toEqual({
      title: 'Hauptstädte Europas',
      description: 'Kennst du die Hauptstädte?',
      published: true,
    });
    expect(fitsInsertWithCategory(values, '10000000-0000-4000-8000-000000000001')).toEqual({
      title: 'Hauptstädte Europas',
      description: 'Kennst du die Hauptstädte?',
      published: true,
      category_id: '10000000-0000-4000-8000-000000000001',
    });
    expect(fitsUpdate(values)).toBe(values);
  });

  it('returns only title, description and published, never category_id, sort_order, id or created_at', () => {
    const values = quizSchema.parse({
      title: 'Hauptstädte Europas',
      description: null,
      published: false,
      category_id: '10000000-0000-4000-8000-000000000002',
      sort_order: 1,
      id: '20000000-0000-4000-8000-000000000001',
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(Object.keys(values).sort()).toEqual(['description', 'published', 'title']);
  });

  it('rejects an empty title', () => {
    expect(titleIssues({ title: '', description: null, published: false })).not.toEqual([]);
  });

  it('rejects a missing title', () => {
    expect(titleIssues({ description: null, published: false })).not.toEqual([]);
  });

  it('rejects a null title', () => {
    expect(titleIssues({ title: null, description: null, published: false })).not.toEqual([]);
  });

  it('rejects every title of only spaces, tabs and line breaks, like the database', () => {
    fc.assert(
      fc.property(blank, (title) => {
        expect(titleIssues({ title, description: null, published: false })).not.toEqual([]);
      }),
    );
  });

  it('accepts every title with a visible character', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((title) => /\S/.test(title)),
        (title) => {
          expect(titleIssues({ title, description: null, published: false })).toEqual([]);
        },
      ),
    );
  });

  it('is never looser than the database: every title it accepts, the database accepts', () => {
    fc.assert(
      fc.property(fc.oneof(blank, fc.string({ unit: 'binary' }), fc.string()), (title) => {
        const accepted = quizSchema.safeParse({
          title,
          description: null,
          published: false,
        }).success;
        if (accepted) expect(databaseAcceptsTitle(title)).toBe(true);
      }),
    );
  });

  it('gives the blank-title error as an i18next key with a German and an English text', () => {
    const [issue] = titleIssues({ title: ' \t ', description: null, published: false });

    expect(issue).toBeDefined();
    expect(issue.message).toBe('admin.quizzes.form.errors.titleRequired');
    expect(i18n.exists(issue.message, { lng: 'de' })).toBe(true);
    expect(i18n.exists(issue.message, { lng: 'en' })).toBe(true);
  });

  it('gives the missing-title error as the same key', () => {
    const [issue] = titleIssues({ description: null, published: false });

    expect(issue?.message).toBe('admin.quizzes.form.errors.titleRequired');
  });

  describe('description is optional', () => {
    it('is null when it is left out', () => {
      expect(quizSchema.parse({ title: 'Komponisten', published: false }).description).toBeNull();
    });

    it('is null when it is null', () => {
      expect(
        quizSchema.parse({ title: 'Komponisten', description: null, published: false }).description,
      ).toBeNull();
    });

    it('is null, not an empty string, when it is empty', () => {
      expect(
        quizSchema.parse({ title: 'Komponisten', description: '', published: false }).description,
      ).toBeNull();
    });

    it('is null when it holds only spaces, tabs and line breaks', () => {
      fc.assert(
        fc.property(blank, (description) => {
          expect(
            quizSchema.parse({ title: 'Komponisten', description, published: false }).description,
          ).toBeNull();
        }),
      );
    });

    it('keeps a description with text', () => {
      expect(
        quizSchema.parse({
          title: 'Komponisten',
          description: 'Wer hat was geschrieben?',
          published: false,
        }).description,
      ).toBe('Wer hat was geschrieben?');
    });
  });

  describe('published', () => {
    it('keeps the flag as given', () => {
      expect(quizSchema.parse({ title: 'Komponisten', published: true }).published).toBe(true);
      expect(quizSchema.parse({ title: 'Komponisten', published: false }).published).toBe(false);
    });

    it('rejects anything that is not a boolean', () => {
      for (const published of ['true', 1, null, undefined]) {
        expect(quizSchema.safeParse({ title: 'Komponisten', published }).success).toBe(false);
      }
    });
  });
});
