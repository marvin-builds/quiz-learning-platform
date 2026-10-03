import * as fc from 'fast-check';

import { scoreQuestion } from '@/domain/scoring';

// Answer ids are UUIDs in the database; any distinct strings will do here.
const answerIds = (minLength: number) => fc.uniqueArray(fc.uuid(), { minLength, maxLength: 8 });

const points = fc.integer({ min: 1, max: 100 });

// A question with exactly one correct answer and at least one wrong one.
const singleChoice = answerIds(2).chain((ids) =>
  fc.nat({ max: ids.length - 1 }).map((index) => ({
    correctIds: [ids[index]],
    wrongIds: ids.filter((_, i) => i !== index),
  })),
);

// A question with at least one correct answer and at least one wrong one.
const multipleChoice = answerIds(2).chain((ids) =>
  fc.integer({ min: 1, max: ids.length - 1 }).map((correctCount) => ({
    correctIds: ids.slice(0, correctCount),
    wrongIds: ids.slice(correctCount),
  })),
);

// A non-empty subset of `ids`, in arbitrary order.
const nonEmptySubset = (ids: readonly string[]) => fc.shuffledSubarray([...ids], { minLength: 1 });

// An id that belongs to no answer of the question.
const unknownId = (known: readonly string[]) => fc.uuid().filter((id) => !known.includes(id));

describe('scoreQuestion: single choice', () => {
  it('gives full points when the correct answer is selected', () => {
    expect(
      scoreQuestion({ type: 'single', correctIds: ['a'], selectedIds: ['a'], points: 3 }),
    ).toBe(3);
  });

  it('gives 0 when a wrong answer is selected', () => {
    expect(
      scoreQuestion({ type: 'single', correctIds: ['a'], selectedIds: ['b'], points: 3 }),
    ).toBe(0);
  });

  it('gives 0 when the correct answer is selected together with a wrong one', () => {
    expect(
      scoreQuestion({ type: 'single', correctIds: ['a'], selectedIds: ['a', 'b'], points: 3 }),
    ).toBe(0);
  });

  it('gives full points for any question when only the correct answer is selected', () => {
    fc.assert(
      fc.property(singleChoice, points, ({ correctIds }, p) => {
        expect(
          scoreQuestion({ type: 'single', correctIds, selectedIds: correctIds, points: p }),
        ).toBe(p);
      }),
    );
  });

  it('gives 0 for any selection other than exactly the correct answer', () => {
    fc.assert(
      fc.property(
        singleChoice.chain((question) =>
          fc.record({
            question: fc.constant(question),
            // Either wrong answers only, or the correct one plus wrong ones.
            selectedIds: fc
              .tuple(fc.boolean(), nonEmptySubset(question.wrongIds))
              .map(([withCorrect, wrong]) =>
                withCorrect ? [...question.correctIds, ...wrong] : wrong,
              ),
          }),
        ),
        points,
        ({ question, selectedIds }, p) => {
          expect(
            scoreQuestion({
              type: 'single',
              correctIds: question.correctIds,
              selectedIds,
              points: p,
            }),
          ).toBe(0);
        },
      ),
    );
  });
});

describe('scoreQuestion: multiple choice', () => {
  it('gives full points when exactly the correct set is selected', () => {
    expect(
      scoreQuestion({
        type: 'multiple',
        correctIds: ['a', 'b', 'c'],
        selectedIds: ['a', 'b', 'c'],
        points: 4,
      }),
    ).toBe(4);
  });

  it('gives proportional partial credit for a correct subset without wrong picks', () => {
    expect(
      scoreQuestion({
        type: 'multiple',
        correctIds: ['a', 'b', 'c', 'd'],
        selectedIds: ['a', 'c'],
        points: 4,
      }),
    ).toBeCloseTo(2);
    expect(
      scoreQuestion({
        type: 'multiple',
        correctIds: ['a', 'b', 'c'],
        selectedIds: ['b'],
        points: 1,
      }),
    ).toBeCloseTo(1 / 3);
  });

  it('gives 0 when a wrong answer is picked, even alongside all correct ones', () => {
    expect(
      scoreQuestion({
        type: 'multiple',
        correctIds: ['a', 'b'],
        selectedIds: ['a', 'b', 'x'],
        points: 4,
      }),
    ).toBe(0);
  });

  it('gives full points for any question when exactly the correct set is selected', () => {
    fc.assert(
      fc.property(
        multipleChoice.chain((question) =>
          fc.record({
            question: fc.constant(question),
            selectedIds: fc.shuffledSubarray(question.correctIds, {
              minLength: question.correctIds.length,
            }),
          }),
        ),
        points,
        ({ question, selectedIds }, p) => {
          expect(
            scoreQuestion({
              type: 'multiple',
              correctIds: question.correctIds,
              selectedIds,
              points: p,
            }),
          ).toBe(p);
        },
      ),
    );
  });

  it('gives points × (selected correct / total correct) for any correct subset', () => {
    fc.assert(
      fc.property(
        multipleChoice.chain((question) =>
          fc.record({
            question: fc.constant(question),
            selectedIds: nonEmptySubset(question.correctIds),
          }),
        ),
        points,
        ({ question, selectedIds }, p) => {
          const expected = (p * selectedIds.length) / question.correctIds.length;
          expect(
            scoreQuestion({
              type: 'multiple',
              correctIds: question.correctIds,
              selectedIds,
              points: p,
            }),
          ).toBeCloseTo(expected, 9);
        },
      ),
    );
  });

  it('gives 0 for any selection that contains a wrong answer', () => {
    fc.assert(
      fc.property(
        multipleChoice.chain((question) =>
          fc.record({
            question: fc.constant(question),
            correctPicks: fc.subarray(question.correctIds),
            wrongPicks: nonEmptySubset(question.wrongIds),
          }),
        ),
        points,
        ({ question, correctPicks, wrongPicks }, p) => {
          expect(
            scoreQuestion({
              type: 'multiple',
              correctIds: question.correctIds,
              selectedIds: [...wrongPicks, ...correctPicks],
              points: p,
            }),
          ).toBe(0);
        },
      ),
    );
  });
});

describe('scoreQuestion: rules for both question types', () => {
  const questionType = fc.constantFrom('single' as const, 'multiple' as const);
  const anyQuestion = questionType.chain((type) =>
    (type === 'single' ? singleChoice : multipleChoice).map((q) => ({ type, ...q })),
  );

  it('gives 0 for an empty selection', () => {
    expect(scoreQuestion({ type: 'single', correctIds: ['a'], selectedIds: [], points: 3 })).toBe(
      0,
    );
    expect(
      scoreQuestion({ type: 'multiple', correctIds: ['a', 'b'], selectedIds: [], points: 3 }),
    ).toBe(0);
  });

  it('gives 0 for an empty selection on any question', () => {
    fc.assert(
      fc.property(anyQuestion, points, ({ type, correctIds }, p) => {
        expect(scoreQuestion({ type, correctIds, selectedIds: [], points: p })).toBe(0);
      }),
    );
  });

  it('treats a selected id that is not an answer of the question as a wrong pick', () => {
    fc.assert(
      fc.property(
        anyQuestion.chain((question) =>
          fc.record({
            question: fc.constant(question),
            unknown: unknownId([...question.correctIds, ...question.wrongIds]),
          }),
        ),
        points,
        ({ question, unknown }, p) => {
          expect(
            scoreQuestion({
              type: question.type,
              correctIds: question.correctIds,
              selectedIds: [...question.correctIds, unknown],
              points: p,
            }),
          ).toBe(0);
        },
      ),
    );
  });

  it('counts a selected id only once when it is selected more than once', () => {
    expect(
      scoreQuestion({ type: 'single', correctIds: ['a'], selectedIds: ['a', 'a'], points: 3 }),
    ).toBe(3);
    expect(
      scoreQuestion({
        type: 'multiple',
        correctIds: ['a', 'b', 'c'],
        selectedIds: ['a', 'a', 'a'],
        points: 3,
      }),
    ).toBeCloseTo(1);
    fc.assert(
      fc.property(
        anyQuestion.chain((question) =>
          fc.record({
            question: fc.constant(question),
            selectedIds: fc.subarray([...question.correctIds, ...question.wrongIds]),
            duplicates: fc.subarray([...question.correctIds, ...question.wrongIds]),
          }),
        ),
        points,
        ({ question, selectedIds, duplicates }, p) => {
          const base = { type: question.type, correctIds: question.correctIds, points: p };
          const once = scoreQuestion({ ...base, selectedIds });
          const repeated = scoreQuestion({
            ...base,
            selectedIds: [...selectedIds, ...duplicates.filter((id) => selectedIds.includes(id))],
          });
          expect(repeated).toBeCloseTo(once, 9);
        },
      ),
    );
  });

  it('does not depend on the order of the selected or correct ids', () => {
    fc.assert(
      fc.property(
        anyQuestion.chain((question) =>
          fc.subarray([...question.correctIds, ...question.wrongIds]).chain((selectedIds) =>
            fc.record({
              question: fc.constant(question),
              selectedIds: fc.constant(selectedIds),
              shuffledSelected: fc.shuffledSubarray(selectedIds, {
                minLength: selectedIds.length,
              }),
              shuffledCorrect: fc.shuffledSubarray(question.correctIds, {
                minLength: question.correctIds.length,
              }),
            }),
          ),
        ),
        points,
        ({ question, selectedIds, shuffledSelected, shuffledCorrect }, p) => {
          const original = scoreQuestion({
            type: question.type,
            correctIds: question.correctIds,
            selectedIds,
            points: p,
          });
          const reordered = scoreQuestion({
            type: question.type,
            correctIds: shuffledCorrect,
            selectedIds: shuffledSelected,
            points: p,
          });
          expect(reordered).toBeCloseTo(original, 9);
        },
      ),
    );
  });

  it('always scores within [0, points] for any selection, including unknown ids', () => {
    fc.assert(
      fc.property(
        anyQuestion.chain((question) =>
          fc.record({
            question: fc.constant(question),
            selectedIds: fc.array(
              fc.oneof(fc.constantFrom(...question.correctIds, ...question.wrongIds), fc.uuid()),
              { maxLength: 12 },
            ),
          }),
        ),
        fc.integer({ min: 0, max: 100 }),
        ({ question, selectedIds }, p) => {
          const score = scoreQuestion({
            type: question.type,
            correctIds: question.correctIds,
            selectedIds,
            points: p,
          });
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(p);
        },
      ),
    );
  });
});
