import * as fc from 'fast-check';

import i18n from '@/i18n';
import { questionWithAnswersSchema } from '@/lib/question-schema';

// The question form's schema with its answers (#82): what the admin sends to
// save_question() for a question and its answers, and nothing more. It
// mirrors the database's rules (question_rules.test.sql), and must never be
// looser than them:
// - a question has at least two answers,
// - at least one of them is correct,
// - a single-choice question (multiple_correct = false) has exactly one,
// - every answer's text holds more than spaces, tabs and line breaks.
// An answer keeps its id when it has one (an existing answer) and gets null
// when it is new. Validation messages are i18next keys, which the form
// translates; the answer rules report on `answers`, a blank text on
// `answers.<index>.text`, so the form can show them next to the answers.

type AnswerInput = { id?: string | null; text: string; is_correct: boolean };

const BLANK_RE = /^[ \t\r\n]*$/;

// The database's rules, written out independently of the schema.
function databaseAccepts(text: string, multipleCorrect: boolean, answers: AnswerInput[]) {
  const correct = answers.filter((answer) => answer.is_correct).length;
  return (
    !BLANK_RE.test(text) &&
    answers.length >= 2 &&
    correct >= 1 &&
    (multipleCorrect || correct === 1) &&
    answers.every((answer) => !BLANK_RE.test(answer.text))
  );
}

const QUESTION = 'Welche dieser Städte liegen an der Donau?';

function parse(multipleCorrect: boolean, answers: AnswerInput[], text = QUESTION) {
  return questionWithAnswersSchema.safeParse({
    text,
    explanation: null,
    multiple_correct: multipleCorrect,
    answers,
  });
}

// The messages of the issues at `path` (joined with '.').
function messagesAt(result: ReturnType<typeof parse>, path: string): string[] {
  if (result.success) return [];
  return result.error.issues
    .filter((issue) => issue.path.map(String).join('.') === path)
    .map((issue) => issue.message);
}

const blank = fc
  .array(fc.constantFrom(' ', '\t', '\r', '\n'), { maxLength: 8 })
  .map((parts) => parts.join(''));

const visibleText = fc.string({ minLength: 1, maxLength: 20 }).filter((text) => /\S/.test(text));

const answer = fc.record({
  text: fc.oneof(visibleText, blank),
  is_correct: fc.boolean(),
});

const ERRORS = {
  tooFew: 'admin.questions.form.errors.answersTooFew',
  correctMissing: 'admin.questions.form.errors.correctMissing',
  singleChoice: 'admin.questions.form.errors.singleChoiceOneCorrect',
  textRequired: 'admin.questions.form.errors.answerTextRequired',
};

describe('questionWithAnswersSchema', () => {
  it('accepts a single-choice question with two answers, one correct, and returns them in order', () => {
    const result = parse(false, [
      { text: 'Paris', is_correct: true },
      { text: 'Lyon', is_correct: false },
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.answers).toEqual([
      { id: null, text: 'Paris', is_correct: true },
      { id: null, text: 'Lyon', is_correct: false },
    ]);
  });

  it('accepts a multiple-choice question with several correct answers', () => {
    const result = parse(true, [
      { text: 'Wien', is_correct: true },
      { text: 'Prag', is_correct: false },
      { text: 'Budapest', is_correct: true },
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.answers.filter((a) => a.is_correct)).toHaveLength(2);
  });

  it('keeps the id of an existing answer and gives a new one null', () => {
    const result = parse(false, [
      { id: '40000000-0000-4000-8000-000000000001', text: 'Paris', is_correct: true },
      { id: null, text: 'Lyon', is_correct: false },
      { text: 'Marseille', is_correct: false },
    ]);

    expect(result.data?.answers.map((a) => a.id)).toEqual([
      '40000000-0000-4000-8000-000000000001',
      null,
      null,
    ]);
  });

  it('returns only id, text and is_correct for each answer, never sort_order, images or question_id', () => {
    const result = questionWithAnswersSchema.safeParse({
      text: QUESTION,
      explanation: null,
      multiple_correct: false,
      answers: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          text: 'Paris',
          is_correct: true,
          sort_order: 1,
          image_path: 'antworten/x.png',
          image_alt: 'Ein Bild',
          question_id: '30000000-0000-4000-8000-000000000001',
        },
        { text: 'Lyon', is_correct: false },
      ],
    });

    expect(result.success).toBe(true);
    expect(Object.keys(result.data?.answers[0] ?? {}).sort()).toEqual(['id', 'is_correct', 'text']);
    expect(Object.keys(result.data ?? {}).sort()).toEqual([
      'answers',
      'explanation',
      'multiple_correct',
      'text',
    ]);
  });

  it('keeps the question rules of questionSchema: a blank question text is rejected', () => {
    const result = parse(
      false,
      [
        { text: 'Paris', is_correct: true },
        { text: 'Lyon', is_correct: false },
      ],
      ' \n',
    );

    expect(messagesAt(result, 'text')).toEqual(['admin.questions.form.errors.textRequired']);
  });

  it('rejects a question with fewer than two answers', () => {
    expect(messagesAt(parse(false, []), 'answers')).toContain(ERRORS.tooFew);
    expect(messagesAt(parse(false, [{ text: 'Paris', is_correct: true }]), 'answers')).toContain(
      ERRORS.tooFew,
    );
  });

  it('rejects a question without a correct answer', () => {
    for (const multiple of [false, true]) {
      const result = parse(multiple, [
        { text: 'Paris', is_correct: false },
        { text: 'Lyon', is_correct: false },
      ]);
      expect(messagesAt(result, 'answers')).toContain(ERRORS.correctMissing);
    }
  });

  it('rejects a single-choice question with more than one correct answer', () => {
    const result = parse(false, [
      { text: 'Wien', is_correct: true },
      { text: 'Budapest', is_correct: true },
      { text: 'Prag', is_correct: false },
    ]);

    expect(messagesAt(result, 'answers')).toContain(ERRORS.singleChoice);
  });

  it('rejects an answer whose text is only spaces, tabs and line breaks, at that answer', () => {
    fc.assert(
      fc.property(blank, (text) => {
        const result = parse(false, [
          { text: 'Paris', is_correct: true },
          { text, is_correct: false },
        ]);
        expect(messagesAt(result, 'answers.1.text')).toEqual([ERRORS.textRequired]);
        expect(messagesAt(result, 'answers.0.text')).toEqual([]);
      }),
    );
  });

  it('rejects a missing answer text', () => {
    const result = questionWithAnswersSchema.safeParse({
      text: QUESTION,
      explanation: null,
      multiple_correct: false,
      answers: [{ text: 'Paris', is_correct: true }, { is_correct: false }],
    });

    expect(messagesAt(result as ReturnType<typeof parse>, 'answers.1.text')).toEqual([
      ERRORS.textRequired,
    ]);
  });

  it('rejects an is_correct that is not a boolean', () => {
    for (const isCorrect of ['true', 1, null, undefined]) {
      const result = questionWithAnswersSchema.safeParse({
        text: QUESTION,
        explanation: null,
        multiple_correct: true,
        answers: [
          { text: 'Wien', is_correct: true },
          { text: 'Prag', is_correct: isCorrect },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it('accepts exactly what the database accepts, for every set of answers', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(answer, { maxLength: 6 }),
        fc.oneof(visibleText, blank),
        (multipleCorrect, answers, text) => {
          expect(parse(multipleCorrect, answers, text).success).toBe(
            databaseAccepts(text, multipleCorrect, answers),
          );
        },
      ),
    );
  });

  it('accepts every multiple-choice question with two or more answers and at least one correct', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.record({ text: visibleText, is_correct: fc.boolean() }), {
            minLength: 2,
            maxLength: 8,
          })
          .filter((answers) => answers.some((a) => a.is_correct)),
        (answers) => {
          expect(parse(true, answers).success).toBe(true);
        },
      ),
    );
  });

  it('accepts every single-choice question with two or more answers and exactly one correct', () => {
    fc.assert(
      fc.property(
        fc.array(visibleText, { minLength: 2, maxLength: 8 }),
        fc.nat(),
        (texts, pick) => {
          const correct = pick % texts.length;
          const answers = texts.map((text, index) => ({ text, is_correct: index === correct }));
          expect(parse(false, answers).success).toBe(true);
        },
      ),
    );
  });

  it.each(Object.values(ERRORS))('%s has a German and an English text', (key) => {
    expect(i18n.exists(key, { lng: 'de' })).toBe(true);
    expect(i18n.exists(key, { lng: 'en' })).toBe(true);
  });

  it('explains in the single-choice message that only one answer may be correct', () => {
    expect(i18n.t(ERRORS.singleChoice as never, { lng: 'de' })).toMatch(/\beine\b/i);
    expect(i18n.t(ERRORS.singleChoice as never, { lng: 'en' })).toMatch(/\bone\b/i);
  });
});
