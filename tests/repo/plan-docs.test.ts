/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PLAN_DIR = path.join(process.cwd(), 'docs', 'plan');

const planDocs = readdirSync(PLAN_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort();

function read(name: string): string {
  return readFileSync(path.join(PLAN_DIR, name), 'utf8');
}

describe('plan docs in docs/plan', () => {
  it('exist, so the checks below cannot pass vacuously', () => {
    expect(planDocs.length).toBeGreaterThan(0);
  });

  it.each(planDocs)('%s has no Obsidian frontmatter block', (name) => {
    expect(read(name)).not.toMatch(/^﻿?---\r?\n/);
  });

  it.each(planDocs)('%s starts with a level-one heading', (name) => {
    expect(read(name)).toMatch(/^# \S/);
  });
});
