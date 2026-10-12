import * as fc from 'fast-check';

import { questionWithAnswersSchema } from '@/lib/question-schema';

// The images of a question and its answers in the question form's schema
// (#83). A question and each answer carry:
// - image_path: the object name in the quiz-images bucket (the app picks a
//   random UUID name when an image is chosen), or null for no image;
// - image_alt: the alt text, required (non-blank after trimming spaces,
//   tabs and line breaks) whenever image_path is set, which mirrors the
//   database's questions_image_alt_required and answers_image_alt_required;
//   stored as null when there is no image;
// - image_file: a newly picked file, not yet uploaded ({ uri, mimeType,
//   size }), or null. It is checked against the bucket's limits before
//   anything is uploaded: at most 5 MiB (5242880 bytes) and one of
//   image/png, image/jpeg, image/webp.
// Missing image fields mean no image, so a payload without them (the forms
// before #83) still parses. Messages are i18next keys under
// admin.questions.form.errors; they report on `image_alt` / `image_file`,
// or `answers.<index>.image_alt` / `answers.<index>.image_file`.

const LIMIT = 5242880;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const ALT_REQUIRED = 'admin.questions.form.errors.imageAltRequired';
const TOO_LARGE = 'admin.questions.form.errors.imageTooLarge';
const WRONG_TYPE = 'admin.questions.form.errors.imageType';

const PATH = '0a1b2c3d-0000-4000-8000-000000000001.png';
const ANSWER_PATH = '0a1b2c3d-0000-4000-8000-000000000002.webp';

type Image = {
  image_path?: string | null;
  image_alt?: string | null;
  image_file?: { uri: string; mimeType: string; size: number } | null;
};

function parse(question: Image = {}, firstAnswer: Image = {}) {
  return questionWithAnswersSchema.safeParse({
    text: 'Welches Tier ist das?',
    explanation: null,
    multiple_correct: false,
    ...question,
    answers: [
      { id: null, text: 'Fuchs', is_correct: true, ...firstAnswer },
      { id: null, text: 'Dachs', is_correct: false },
    ],
  });
}

// The parsed values as this test reads them, typed here so a field the
// schema doesn't have yet fails at run time with its name.
type Parsed = Image & { answers: Image[] };
const valuesOf = (result: ReturnType<typeof parse>) => result.data as unknown as Parsed | undefined;

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
const missingAlt = fc.oneof(blank, fc.constant(null), fc.constant(undefined));
const visibleAlt = fc.string({ minLength: 1, maxLength: 40 }).filter((alt) => /\S/.test(alt));

const file = (size: number, mimeType = 'image/png') => ({
  uri: 'file:///picked/fuchs.png',
  mimeType,
  size,
});

describe('questionWithAnswersSchema: images', () => {
  it('keeps a question image with its alt text', () => {
    const result = parse({ image_path: PATH, image_alt: 'Ein Fuchs im Gras' });

    expect(result.success).toBe(true);
    expect(valuesOf(result)).toMatchObject({ image_path: PATH, image_alt: 'Ein Fuchs im Gras' });
  });

  it('keeps an answer image with its alt text', () => {
    const result = parse({}, { image_path: ANSWER_PATH, image_alt: 'Ein roter Fuchs' });

    expect(result.success).toBe(true);
    expect(valuesOf(result)?.answers[0]).toMatchObject({
      image_path: ANSWER_PATH,
      image_alt: 'Ein roter Fuchs',
    });
    expect(valuesOf(result)?.answers[1]).toMatchObject({ image_path: null, image_alt: null });
  });

  it('reads missing image fields as no image, for the question and every answer', () => {
    const result = parse();

    expect(result.success).toBe(true);
    expect(valuesOf(result)).toMatchObject({ image_path: null, image_alt: null, image_file: null });
    for (const answer of valuesOf(result)?.answers ?? []) {
      expect(answer).toMatchObject({ image_path: null, image_alt: null, image_file: null });
    }
  });

  it('requires an alt text for a question image: missing, null or blank is refused', () => {
    fc.assert(
      fc.property(missingAlt, (alt) => {
        const result = parse({ image_path: PATH, image_alt: alt });
        expect(result.success).toBe(false);
        expect(messagesAt(result, 'image_alt')).toEqual([ALT_REQUIRED]);
      }),
    );
  });

  it('requires an alt text for an answer image, reported on that answer', () => {
    fc.assert(
      fc.property(missingAlt, (alt) => {
        const result = parse({}, { image_path: ANSWER_PATH, image_alt: alt });
        expect(result.success).toBe(false);
        expect(messagesAt(result, 'answers.0.image_alt')).toEqual([ALT_REQUIRED]);
        expect(messagesAt(result, 'image_alt')).toEqual([]);
      }),
    );
  });

  it('accepts any alt text with a visible character for an image', () => {
    fc.assert(
      fc.property(visibleAlt, (alt) => {
        const question = parse({ image_path: PATH, image_alt: alt });
        const answer = parse({}, { image_path: ANSWER_PATH, image_alt: alt });
        expect(question.success).toBe(true);
        expect(valuesOf(question)?.image_alt).toBe(alt);
        expect(answer.success).toBe(true);
        expect(valuesOf(answer)?.answers[0].image_alt).toBe(alt);
      }),
    );
  });

  it('needs no alt text without an image, and stores none', () => {
    fc.assert(
      fc.property(fc.oneof(missingAlt, visibleAlt), (alt) => {
        const result = parse({ image_path: null, image_alt: alt }, { image_alt: alt });
        expect(result.success).toBe(true);
        expect(valuesOf(result)?.image_alt).toBeNull();
        expect(valuesOf(result)?.answers[0].image_alt).toBeNull();
      }),
    );
  });

  it('accepts a picked file of exactly 5 MiB and refuses one byte more', () => {
    const atLimit = parse({ image_path: PATH, image_alt: 'Ein Fuchs', image_file: file(LIMIT) });
    const over = parse({ image_path: PATH, image_alt: 'Ein Fuchs', image_file: file(LIMIT + 1) });

    expect(atLimit.success).toBe(true);
    expect(valuesOf(atLimit)?.image_file).toEqual(file(LIMIT));
    expect(messagesAt(over, 'image_file')).toEqual([TOO_LARGE]);
  });

  it('refuses every picked file larger than 5 MiB and accepts every smaller one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 * LIMIT }), (size) => {
        const result = parse({ image_path: PATH, image_alt: 'Ein Fuchs', image_file: file(size) });
        expect(messagesAt(result, 'image_file')).toEqual(size > LIMIT ? [TOO_LARGE] : []);
      }),
    );
  });

  it('accepts png, jpeg and webp files', () => {
    for (const type of TYPES) {
      const result = parse({
        image_path: PATH,
        image_alt: 'Ein Fuchs',
        image_file: file(1024, type),
      });
      expect(result.success).toBe(true);
      expect(valuesOf(result)?.image_file).toEqual(file(1024, type));
    }
  });

  it('refuses every other file type', () => {
    const otherType = fc.oneof(
      fc.constantFrom(
        'image/gif',
        'image/svg+xml',
        'image/heic',
        'text/html',
        'application/pdf',
        '',
      ),
      fc.string({ maxLength: 30 }),
    );
    fc.assert(
      fc.property(
        otherType.filter((type) => !(TYPES as readonly string[]).includes(type)),
        (type) => {
          const result = parse({
            image_path: PATH,
            image_alt: 'Ein Fuchs',
            image_file: file(1024, type),
          });
          expect(messagesAt(result, 'image_file')).toEqual([WRONG_TYPE]);
        },
      ),
    );
  });

  it('checks an answer’s picked file the same way, reported on that answer', () => {
    const big = parse(
      {},
      { image_path: ANSWER_PATH, image_alt: 'Ein Fuchs', image_file: file(LIMIT + 1) },
    );
    const gif = parse(
      {},
      { image_path: ANSWER_PATH, image_alt: 'Ein Fuchs', image_file: file(1024, 'image/gif') },
    );

    expect(messagesAt(big, 'answers.0.image_file')).toEqual([TOO_LARGE]);
    expect(messagesAt(gif, 'answers.0.image_file')).toEqual([WRONG_TYPE]);
  });
});
