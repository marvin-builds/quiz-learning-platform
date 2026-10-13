/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Decisions of the phase 2 security review (#37) that later slices must pick
// up go into the plan's decisions table: the hosted password policy (phase 3
// sign-up and password reset must show Supabase's weak_password error as
// translated text) and the row locks of the rule triggers and submit_answer.

const PLAN = path.join(process.cwd(), 'docs', 'plan', 'mvp-implementation-plan.md');

// The table rows of the "Decisions" section, up to the next level-two heading.
function decisionRows(): string[] {
  const text = readFileSync(PLAN, 'utf8');
  const start = text.search(/^## \d+\. Decisions\s*$/m);
  if (start === -1) throw new Error('the plan has no Decisions section');
  const rest = text.slice(start);
  const next = rest.slice(3).search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next + 3);
  return section.split(/\r?\n/).filter((line) => line.startsWith('|'));
}

describe('security review decisions in the plan', () => {
  it('has decision rows to search, so the checks below cannot pass vacuously', () => {
    expect(decisionRows().length).toBeGreaterThan(0);
  });

  it('records the hosted password policy and that sign-up must handle weak_password', () => {
    const rows = decisionRows().filter((row) => /password/i.test(row));
    expect(rows.some((row) => /\b12\b/.test(row) && /weak_password/.test(row))).toBe(true);
  });

  // One row for both or a row each: the table layout is the plan's choice.
  // The lock mode is what only the new decision can contain: FOR NO KEY UPDATE.
  it('records the row locks of the rule triggers', () => {
    const rows = decisionRows().filter((row) => /lock/i.test(row));
    expect(
      rows.some(
        (row) =>
          /check_quiz_publish_rules|check_question_rules|rule trigger/i.test(row) &&
          /no key update/i.test(row),
      ),
    ).toBe(true);
  });

  // The existing 'Answer checking' row already names submit_answer and its
  // attempt lock, so only the share lock on quiz and category is new.
  it('records the share lock of submit_answer on quiz and category', () => {
    const rows = decisionRows().filter((row) => /lock/i.test(row));
    expect(rows.some((row) => /submit_answer/.test(row) && /for share/i.test(row))).toBe(true);
  });
});
