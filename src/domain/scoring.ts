export type QuestionType = 'single' | 'multiple';

export interface ScoringInput {
  type: QuestionType;
  correctIds: readonly string[];
  selectedIds: readonly string[];
  points: number;
}

/**
 * Scores one answered question. Any wrong pick (including an id that is not
 * an answer of the question) scores 0. Multiple choice gives proportional
 * credit for a correct subset; repeated ids count once.
 */
export function scoreQuestion({ type, correctIds, selectedIds, points }: ScoringInput): number {
  const correct = new Set(correctIds);
  const selected = new Set(selectedIds);

  if (selected.size === 0) return 0;
  for (const id of selected) {
    if (!correct.has(id)) return 0;
  }

  if (type === 'single') return points;
  return (points * selected.size) / correct.size;
}
