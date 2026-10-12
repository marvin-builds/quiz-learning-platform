import * as fc from 'fast-check';

import i18n from '@/i18n';
import { questionSchema } from '@/lib/question-schema';
import type { TablesInsert, TablesUpdate } from '@/types/database';

// The question form's zod schema (#81): what the admin may send for a
// question, and nothing more. The database checks the same rules again (the
// text must not be blank once ' \t\r\n' are trimmed); the schema must never
// be looser. An explanation that is empty after trimming is stored as null,
// so "no explanation" means the same in the form and the database. The quiz
// comes from the route, sort_order from the database, and images are item 5.
// Validation messages are i18next keys, which the form translates.

type QuestionValues = ReturnType<typeof questionSchema.parse>;

// Compile-time checks against the generated types; `npm run typecheck` fails
// when they don't hold.
type Writable = Pick<TablesInsert<'questions'>, 'text' | 'explanation' | 'multiple_correct'>;
const fitsInsert = (values: QuestionValues): Writable => values;
const fitsInsertWithQuiz = (
  values: QuestionValues,
  quizId: string,
): Omit<TablesInsert<'questions'>, 'sort_order'> => ({ ...values, quiz_id: quizId });
const fitsUpdate = (values: QuestionValues): TablesUpdate<'questions'> => values;

// The database's rule: btrim(text, E' \t\r\n') is not empty.
const databaseAcceptsText = (text: string) => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') !== '';

const blank = fc
  .array(fc.constantFrom(' ', '\t', '\r', '\n'), { maxLength: 12 })
  .map((parts) => parts.join(''));

function textIssues(input: unknown) {
  const result = questionSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.filter((issue) => issue.path[0] === 'text');
}

describe('questionSchema', () => {
  it('accepts a text, an explanation and multiple_correct', () => {
    const values = questionSchema.parse({
      text: 'Was ist die Hauptstadt von Frankreich?',
      explanation: 'Paris ist seit dem Mittelalter die Hauptstadt.',
      multiple_correct: false,
    });

    expect(fitsInsert(values)).toEqual({
      text: 'Was ist die Hauptstadt von Frankreich?',
      explanation: 'Paris ist seit dem Mittelalter die Hauptstadt.',
      multiple_correct: false,
    });
    expect(fitsInsertWithQuiz(values, '20000000-0000-4000-8000-000000000001')).toEqual({
      text: 'Was ist die Hauptstadt von Frankreich?',
      explanation: 'Paris ist seit dem Mittelalter die Hauptstadt.',
      multiple_correct: false,
      quiz_id: '20000000-0000-4000-8000-000000000001',
    });
    expect(fitsUpdate(values)).toBe(values);
  });

  it('returns only text, explanation and multiple_correct, never quiz_id, images, sort_order, id or created_at', () => {
    const values = questionSchema.parse({
      text: 'Welche dieser Elemente sind Edelgase?',
      explanation: null,
      multiple_correct: true,
      quiz_id: '20000000-0000-4000-8000-000000000003',
      image_path: 'fragen/x.png',
      image_alt: 'Ein Bild',
      sort_order: 1,
      id: '30000000-0000-4000-8000-000000000004',
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(Object.keys(values).sort()).toEqual(['explanation', 'multiple_correct', 'text']);
  });

  it('rejects an empty text', () => {
    expect(textIssues({ text: '', explanation: null, multiple_correct: false })).not.toEqual([]);
  });

  it('rejects a missing text', () => {
    expect(textIssues({ explanation: null, multiple_correct: false })).not.toEqual([]);
  });

  it('rejects a null text', () => {
    expect(textIssues({ text: null, explanation: null, multiple_correct: false })).not.toEqual([]);
  });

  it('rejects every text of only spaces, tabs and line breaks, like the database', () => {
    fc.assert(
      fc.property(blank, (text) => {
        expect(textIssues({ text, explanation: null, multiple_correct: false })).not.toEqual([]);
      }),
    );
  });

  it('accepts every text with a visible character', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((text) => /\S/.test(text)),
        (text) => {
          expect(textIssues({ text, explanation: null, multiple_correct: false })).toEqual([]);
        },
      ),
    );
  });

  it('is never looser than the database: every text it accepts, the database accepts', () => {
    fc.assert(
      fc.property(fc.oneof(blank, fc.string({ unit: 'binary' }), fc.string()), (text) => {
        const accepted = questionSchema.safeParse({
          text,
          explanation: null,
          multiple_correct: false,
        }).success;
        if (accepted) expect(databaseAcceptsText(text)).toBe(true);
      }),
    );
  });

  it('gives the blank-text error as an i18next key with a German and an English text', () => {
    const [issue] = textIssues({ text: '\n\t', explanation: null, multiple_correct: false });

    expect(issue).toBeDefined();
    expect(issue.message).toBe('admin.questions.form.errors.textRequired');
    expect(i18n.exists(issue.message, { lng: 'de' })).toBe(true);
    expect(i18n.exists(issue.message, { lng: 'en' })).toBe(true);
  });

  it('gives the missing-text error as the same key', () => {
    const [issue] = textIssues({ explanation: null, multiple_correct: false });

    expect(issue?.message).toBe('admin.questions.form.errors.textRequired');
  });

  describe('explanation is optional', () => {
    const text = 'Welches chemische Symbol hat Gold?';

    it('is null when it is left out', () => {
      expect(questionSchema.parse({ text, multiple_correct: false }).explanation).toBeNull();
    });

    it('is null when it is null', () => {
      expect(
        questionSchema.parse({ text, explanation: null, multiple_correct: false }).explanation,
      ).toBeNull();
    });

    it('is null, not an empty string, when it is empty', () => {
      expect(
        questionSchema.parse({ text, explanation: '', multiple_correct: false }).explanation,
      ).toBeNull();
    });

    it('is null when it holds only spaces, tabs and line breaks', () => {
      fc.assert(
        fc.property(blank, (explanation) => {
          expect(
            questionSchema.parse({ text, explanation, multiple_correct: false }).explanation,
          ).toBeNull();
        }),
      );
    });

    it('keeps an explanation with text, line breaks included', () => {
      expect(
        questionSchema.parse({
          text,
          explanation: 'Au kommt vom lateinischen Wort „aurum“.\nMerke: Au!',
          multiple_correct: false,
        }).explanation,
      ).toBe('Au kommt vom lateinischen Wort „aurum“.\nMerke: Au!');
    });
  });

  describe('multiple_correct', () => {
    const text = 'Welche dieser Hauptstädte liegen an der Donau?';

    it('keeps the flag as given', () => {
      expect(questionSchema.parse({ text, multiple_correct: true }).multiple_correct).toBe(true);
      expect(questionSchema.parse({ text, multiple_correct: false }).multiple_correct).toBe(false);
    });

    it('rejects anything that is not a boolean', () => {
      for (const multiple_correct of ['true', 1, null, undefined]) {
        expect(questionSchema.safeParse({ text, multiple_correct }).success).toBe(false);
      }
    });
  });
});
