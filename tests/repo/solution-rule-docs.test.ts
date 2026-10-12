/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), 'utf8');

// Issue #81: the admin reads questions.explanation through the admin-only
// function admin_question(). The never-break rule protects learners, but its
// wording says the explanation is "only reachable through submit_answer", so
// every later review would flag the new function as a leak. The rule is
// amended where agents and reviews read it: learners only through
// submit_answer, admins also through the named admin-only function. CLAUDE.md
// changes together with an ADR ("Changing these rules").

// The paragraph or table row that starts with `start`, up to the next blank
// line (or the end of the line for a table row).
function block(text: string, start: string): string {
  const from = text.indexOf(start);
  if (from < 0) return '';
  const rest = text.slice(from);
  const end = start.startsWith('|') ? rest.indexOf('\n') : rest.search(/\n\s*\n|\n- \*\*/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('the solution rule names the admin path', () => {
  it('CLAUDE.md: learners only through submit_answer, admins also through admin_question', () => {
    const rule = block(read('CLAUDE.md'), '- **Learners never see the solutions.**');

    expect(rule).not.toBe('');
    expect(rule).toContain('submit_answer');
    expect(rule).toContain('admin_question');
    expect(rule).toMatch(/admin/i);
    // Scores stay out of the client's reach.
    expect(rule).toMatch(/client can't write them/);
  });

  it('ADR 0002 has a dated addendum for the admin read of the explanation', () => {
    const adr = read('docs', 'adr', '0002-supabase-backend.md');
    const heading = adr
      .split('\n')
      .find((line) => /^#{3,4} (Amendment|Addendum) \(\d{4}-\d{2}-\d{2}\):.*admin/i.test(line));

    expect(heading).toBeDefined();
    const section = adr.slice(adr.indexOf(heading as string));
    expect(section).toContain('admin_question');
    expect(section).toContain('private.is_admin()');
  });

  it('the plan decisions row for admins names the path instead of leaving it to the editor slices', () => {
    const plan = read('docs', 'plan', 'mvp-implementation-plan.md');
    const row = block(plan, '| Admins |');

    expect(row).not.toBe('');
    expect(row).toContain('admin_question');
    expect(row).not.toContain('the editor slices decide that path');
  });

  it('the reviewer checks solutions against submit_answer for learners and admin_question for admins', () => {
    const check = block(read('.claude', 'agents', 'reviewer.md'), '1. **Solutions stay hidden.**');

    expect(check).not.toBe('');
    expect(check).toContain('submit_answer');
    expect(check).toContain('admin_question');
  });

  it('the test-writer treats admin_question as a known path that needs refusal tests', () => {
    const rules = read('.claude', 'agents', 'test-writer.md');
    const database = block(rules, '- **Database:**');

    expect(database).not.toBe('');
    expect(database).toContain('submit_answer');
    expect(database).toContain('admin_question');
  });
});
