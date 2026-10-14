/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), 'utf8');

// Admin rights need a second factor (#122). The docs say so where the access
// rules live, record the decision, and describe what the owner does when an
// admin loses the authenticator: a manual reset in the Supabase dashboard
// (delete the admin's TOTP factor), after which the admin enrolls again at
// the next sign-in. They also name the window this leaves (until the admin
// enrolls, the password alone is enough to enroll a factor) and the deploy
// order. CLAUDE.md's seed admin line mentions the TOTP factor and where its
// local-only secret lives.

// The table rows of the plan's "Decisions" section, up to the next
// level-two heading.
function decisionRows(): string[] {
  const text = read('docs', 'plan', 'mvp-implementation-plan.md');
  const start = text.search(/^## \d+\. Decisions\s*$/m);
  if (start === -1) throw new Error('the plan has no Decisions section');
  const rest = text.slice(start);
  const next = rest.slice(3).search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next + 3);
  return section.split(/\r?\n/).filter((line) => line.startsWith('|'));
}

// Where the decision may be recorded: the plan's decisions table or an ADR
// 0002 addendum, the place the other access rule decisions went.
function decisionTexts(): string[] {
  return [...decisionRows(), read('docs', 'adr', '0002-supabase-backend.md')];
}

describe('docs for the admin second factor', () => {
  it('the overview says admin rights need role admin and an aal2 session', () => {
    const overview = read('docs', 'plan', 'overview.md');
    const adminRow = overview.split('\n').find((line) => line.startsWith('| Admin |'));
    expect(adminRow).toBeDefined();
    expect(adminRow).toMatch(/aal2|second factor|TOTP/i);
    expect(overview).toMatch(/aal2/);
  });

  it('the overview mentions TOTP for the admin login', () => {
    const overview = read('docs', 'plan', 'overview.md');
    expect(overview).toMatch(/TOTP/);
  });

  it('records the decision in the plan or in ADR 0002', () => {
    expect(decisionTexts().some((part) => /aal2/.test(part) && /TOTP/.test(part))).toBe(true);
  });

  it('documents recovery as a manual reset of the TOTP factor in the Supabase dashboard', () => {
    const docs = [read('docs', 'plan', 'overview.md'), ...decisionTexts()].join('\n');
    expect(docs).toMatch(/recover/i);
    expect(docs).toMatch(/dashboard/i);
    expect(docs).toMatch(/factor/i);
    expect(
      docs
        .split(/\n\s*\n/)
        .some(
          (block) =>
            /recover/i.test(block) &&
            /dashboard/i.test(block) &&
            /(delete|remove|reset)/i.test(block) &&
            /factor/i.test(block),
        ),
    ).toBe(true);
  });

  it('documents the enrollment window and the deploy order', () => {
    const docs = [read('docs', 'plan', 'overview.md'), ...decisionTexts()].join('\n');
    expect(docs).toMatch(/enrol/i);
    expect(docs).toMatch(/deploy/i);
    expect(
      docs
        .split(/\n\s*\n|\n(?=\|)/)
        .some((block) => /enrol/i.test(block) && /password/i.test(block) && /aal1/i.test(block)),
    ).toBe(true);
  });

  it('CLAUDE.md says the seed admin has a TOTP factor and where its secret lives', () => {
    const claude = read('CLAUDE.md');
    const line = claude.split('\n').find((candidate) => candidate.includes('admin@example.com'));
    expect(line).toBeDefined();
    const paragraph = claude.slice(claude.indexOf(line!)).split(/\n(?=- |\n)/)[0]!;
    expect(paragraph).toMatch(/TOTP/);
    expect(paragraph).toMatch(/e2e\/admin-auth\.ts|seed\.sql/);
    // Where the secret lives, not the secret itself (read from the helper,
    // so this check follows a changed secret).
    const secret = /totpSecret:\s*'([A-Z2-7]+)'/.exec(read('e2e', 'admin-auth.ts'))?.[1];
    expect(secret).toBeDefined();
    expect(claude).not.toContain(secret!);
  });
});
