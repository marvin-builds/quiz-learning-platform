/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), 'utf8');

// Issue #79: the local seed admin is documented where agents look first, and
// the plan records how the first hosted admin comes about, since nobody may
// reach the hosted database from the dev machine.
describe('docs for the admin role', () => {
  it('CLAUDE.md names the local seed admin and its password', () => {
    const claude = read('CLAUDE.md');
    expect(claude).toContain('admin@example.com');
    expect(claude).toContain('admin-password');
  });

  it('the plan decisions table records how the first hosted admin is created', () => {
    const plan = read('docs', 'plan', 'mvp-implementation-plan.md');
    const decisions = plan.slice(plan.indexOf('## 7. Decisions'));
    expect(plan).toContain('## 7. Decisions');

    const row = decisions.split('\n').find((line) => line.startsWith('| First hosted admin |'));
    expect(row).toBeDefined();
    // Topic and a decision that says something, not an empty cell.
    expect(row?.split('|')[2]?.trim()).toMatch(/\S{3,}/);
  });
});
