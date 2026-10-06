/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), 'utf8');

describe('docs for one Supabase stack per worktree', () => {
  it('feature-slice cleanup stops the worktree stack and drops its volumes before removing the worktree', () => {
    const skill = read('.claude', 'skills', 'feature-slice', 'SKILL.md');
    const step8 = skill.slice(skill.indexOf('## 8.'));
    expect(skill).toContain('## 8.');

    const stop = step8.indexOf('npx supabase stop --no-backup --workdir');
    const remove = step8.indexOf('git worktree remove');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(stop);
  });

  it('CLAUDE.md names scripts/stack.mjs', () => {
    expect(read('CLAUDE.md')).toContain('scripts/stack.mjs');
  });

  it('the plan no longer runs database slices one at a time', () => {
    const plan = read('docs', 'plan', 'mvp-implementation-plan.md');
    const row = plan.split('\n').find((line) => line.startsWith('| Parallelism'));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/one at a time/i);
  });

  it('the mobile smoke test explains .env.local over Wi-Fi in a worktree', () => {
    const doc = read('docs', 'mobile-smoke-test.md');
    const start = doc.indexOf('**Wi-Fi:**');
    expect(start).toBeGreaterThanOrEqual(0);
    const bullet = doc.slice(start).split(/\n(?=\S)/)[0];
    expect(bullet).toMatch(/worktree/i);
  });
});
