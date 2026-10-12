/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const decisions = () => {
  const plan = read('docs', 'plan', 'mvp-implementation-plan.md');
  return plan.slice(plan.indexOf('## 7. Decisions'));
};

// The row of the decisions table whose topic is `topic`.
const row = (topic: string) =>
  decisions()
    .split('\n')
    .find((line) => line.startsWith(`| ${topic} |`));

// Issue #84: the reorder design and the preview's data path are recorded in
// the plan's decisions, and the new admin functions in the overview's access
// rules, so a later slice finds them without reading the migrations.
describe('docs for reordering and the preview', () => {
  it('the plan records the reorder design: the functions, the full-list contract, the lock and answers through save_question', () => {
    const reorder = row('Reordering');
    expect(reorder).toBeDefined();
    for (const name of ['reorder_categories', 'reorder_quizzes', 'reorder_questions']) {
      expect(reorder).toContain(name);
    }
    expect(reorder).toMatch(/full|whole|every/i);
    expect(reorder).toMatch(/advisory lock/i);
    expect(reorder).toContain('save_question');
  });

  it('the plan records the preview’s data path: admin reads only, no attempt, nothing written', () => {
    const preview = row('Preview');
    expect(preview).toBeDefined();
    expect(preview).toContain('admin_question');
    expect(preview).toContain('admin_answers');
    expect(preview).toContain('start_attempt');
    expect(preview).toMatch(
      /\/admin\/quizzes\/\[quizId\]\/preview|\/admin\/quizzes\/<quizId>\/preview/,
    );
  });

  it('the overview’s access rules name the reorder functions as admin-only', () => {
    const overview = read('docs', 'plan', 'overview.md');
    const rules = overview.slice(overview.indexOf('**Access rules'));
    for (const name of ['reorder_categories', 'reorder_quizzes', 'reorder_questions']) {
      expect(rules).toContain(name);
    }
  });
});
