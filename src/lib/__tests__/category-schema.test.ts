import * as fc from 'fast-check';

import i18n from '@/i18n';
import { categorySchema } from '@/lib/category-schema';
import type { TablesInsert, TablesUpdate } from '@/types/database';

// The category form's zod schema (#80): what the admin may send for a
// category, and nothing more. The database checks the same rules again
// (categories_name_check trims ' \t\r\n'); the schema must never be looser,
// so a name the form accepts is one the database accepts too. A description
// that is empty after trimming is stored as null, not '', so the form and
// the database agree on "no description". Validation messages are i18next
// keys, which the form translates.

type CategoryValues = ReturnType<typeof categorySchema.parse>;

// The parsed values are what the client may write: they fit the generated
// insert and update types and hold only the columns the admin may write.
// Compile-time checks; `npm run typecheck` fails when they don't hold.
type Writable = Pick<TablesInsert<'categories'>, 'name' | 'description' | 'published'>;
const fitsInsert = (values: CategoryValues): Writable => values;
const fitsUpdate = (values: CategoryValues): TablesUpdate<'categories'> => values;

// The database's rule: btrim(name, E' \t\r\n') is not empty.
const databaseAcceptsName = (name: string) => name.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') !== '';

const blankName = fc
  .array(fc.constantFrom(' ', '\t', '\r', '\n'), { maxLength: 12 })
  .map((parts) => parts.join(''));

function nameIssues(input: unknown) {
  const result = categorySchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.filter((issue) => issue.path[0] === 'name');
}

describe('categorySchema', () => {
  it('accepts a name, a description and the published flag', () => {
    const values = categorySchema.parse({
      name: 'Geografie',
      description: 'Länder, Städte und Flüsse',
      published: true,
    });

    expect(fitsInsert(values)).toEqual({
      name: 'Geografie',
      description: 'Länder, Städte und Flüsse',
      published: true,
    });
    expect(fitsUpdate(values)).toBe(values);
  });

  it('returns only name, description and published, never sort_order, id or created_at', () => {
    const values = categorySchema.parse({
      name: 'Geografie',
      description: null,
      published: false,
      sort_order: 1,
      id: '10000000-0000-4000-8000-000000000001',
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(Object.keys(values).sort()).toEqual(['description', 'name', 'published']);
  });

  it('rejects an empty name', () => {
    expect(nameIssues({ name: '', description: null, published: false })).not.toEqual([]);
  });

  it('rejects a missing name', () => {
    expect(nameIssues({ description: null, published: false })).not.toEqual([]);
  });

  it('rejects every name of only spaces, tabs and line breaks, like the database', () => {
    fc.assert(
      fc.property(blankName, (name) => {
        expect(nameIssues({ name, description: null, published: false })).not.toEqual([]);
      }),
    );
  });

  it('accepts every name with a visible character', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((name) => /\S/.test(name)),
        (name) => {
          expect(nameIssues({ name, description: null, published: false })).toEqual([]);
        },
      ),
    );
  });

  it('is never looser than the database: every name it accepts, the database accepts', () => {
    fc.assert(
      fc.property(fc.oneof(blankName, fc.string({ unit: 'binary' }), fc.string()), (name) => {
        const accepted = categorySchema.safeParse({
          name,
          description: null,
          published: false,
        }).success;
        if (accepted) expect(databaseAcceptsName(name)).toBe(true);
      }),
    );
  });

  it('gives the blank-name error as an i18next key with a German and an English text', () => {
    const [issue] = nameIssues({ name: ' \t ', description: null, published: false });

    expect(issue).toBeDefined();
    expect(i18n.exists(issue.message, { lng: 'de' })).toBe(true);
    expect(i18n.exists(issue.message, { lng: 'en' })).toBe(true);
  });

  describe('description is optional', () => {
    it('is null when it is left out', () => {
      expect(categorySchema.parse({ name: 'Musik', published: false }).description).toBeNull();
    });

    it('is null when it is null', () => {
      expect(
        categorySchema.parse({ name: 'Musik', description: null, published: false }).description,
      ).toBeNull();
    });

    it('is null, not an empty string, when it is empty', () => {
      expect(
        categorySchema.parse({ name: 'Musik', description: '', published: false }).description,
      ).toBeNull();
    });

    it('is null when it holds only spaces, tabs and line breaks', () => {
      fc.assert(
        fc.property(blankName, (description) => {
          expect(
            categorySchema.parse({ name: 'Musik', description, published: false }).description,
          ).toBeNull();
        }),
      );
    });

    it('keeps a description with text', () => {
      expect(
        categorySchema.parse({
          name: 'Musik',
          description: 'Komponisten und Instrumente',
          published: false,
        }).description,
      ).toBe('Komponisten und Instrumente');
    });
  });

  it('keeps the published flag as given', () => {
    expect(categorySchema.parse({ name: 'Musik', published: true }).published).toBe(true);
    expect(categorySchema.parse({ name: 'Musik', published: false }).published).toBe(false);
  });
});
