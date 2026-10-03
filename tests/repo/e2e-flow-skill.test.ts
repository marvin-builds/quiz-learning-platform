/**
 * @jest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKILL = path.join(ROOT, '.claude', 'skills', 'e2e-flow', 'SKILL.md');
const E2E_DIR = path.join(ROOT, 'e2e');

// The skill file split into its YAML frontmatter (flat `key: value` lines)
// and the Markdown body after it.
function skill(): { meta: Record<string, string>; body: string } {
  if (!existsSync(SKILL)) throw new Error('.claude/skills/e2e-flow/SKILL.md does not exist');
  const text = readFileSync(SKILL, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('e2e-flow SKILL.md has no frontmatter');
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const pair = /^(\w+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].trim();
  }
  return { meta, body: match[2] };
}

describe('the e2e-flow skill', () => {
  it('declares its name and a description in the frontmatter', () => {
    const { meta } = skill();

    expect(meta.name).toBe('e2e-flow');
    expect(meta.description?.length).toBeGreaterThan(0);
  });

  it('selects elements by role and by the translated text from the locale file', () => {
    const { body } = skill();

    expect(body).toContain('getByRole');
    expect(body).toMatch(/locales\/de\.json|import de from/);
  });

  it('rules out sleeps (waitForTimeout)', () => {
    expect(skill().body).toContain('waitForTimeout');
  });

  it('requires a reset database per run', () => {
    expect(skill().body).toMatch(/db reset/);
  });

  it('explains how to read the traces of a failed run', () => {
    expect(skill().body).toMatch(/show-trace|test-results/);
  });

  it('points to the axe helper in e2e/axe.ts', () => {
    const { body } = skill();

    expect(body).toContain('expectNoSeriousAxeViolations');
    expect(body).toContain('e2e/axe.ts');
  });
});

describe('the e2e specs', () => {
  it('never sleep with waitForTimeout', () => {
    const specs = readdirSync(E2E_DIR).filter((file) => file.endsWith('.spec.ts'));

    // Without specs the check below would pass vacuously.
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(readFileSync(path.join(E2E_DIR, spec), 'utf8')).not.toContain('waitForTimeout');
    }
  });
});
