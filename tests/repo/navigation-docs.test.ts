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

// Issue #116: the navigation model is a new product decision, recorded in
// the plan's decisions so later slices (the phase 3 account menu, #117's
// short labels) build on it instead of rediscovering it.
describe('docs for the navigation', () => {
  it('the plan records the navigation model: one shared header, up to the logical parent, browser back as history', () => {
    const navigation = row('Navigation');
    expect(navigation).toBeDefined();
    expect(navigation).toMatch(/header/i);
    expect(navigation).toMatch(/logical parent/i);
    expect(navigation).toMatch(/breadcrumb/i);
    expect(navigation).toMatch(/history/i);
  });

  it('the plan records that /admin has no dashboard and lands on the category list, with sign-out in the header', () => {
    const navigation = row('Navigation');
    expect(navigation).toBeDefined();
    expect(navigation).toMatch(/dashboard/i);
    expect(navigation).toContain('/admin/categories');
    expect(navigation).toMatch(/sign[- ]out|Abmelden/i);
  });

  it('the plan records when leaving asks: a started quiz and a changed admin form', () => {
    const navigation = row('Navigation');
    expect(navigation).toBeDefined();
    expect(navigation).toMatch(/confirm/i);
    expect(navigation).toMatch(/quiz/i);
    expect(navigation).toMatch(/form/i);
  });
});
