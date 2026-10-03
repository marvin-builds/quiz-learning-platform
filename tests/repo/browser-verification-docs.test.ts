/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

// The text of the `## <title>` section, up to the next `## ` heading.
function section(text: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
  if (!match) throw new Error(`no "## ${title}" section`);
  return match[1];
}

// The text of all `### Amendment…` sections of ADR 0003, each up to the
// next heading of level 2 or 3 or the end of the file.
function adrAmendments(): string {
  const text = read('docs/adr/0003-agentic-test-first-workflow.md');
  return [...text.matchAll(/^### Amendment\b.*$([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/gm)]
    .map((match) => match[0])
    .join('\n');
}

describe('the docs name the browser verification', () => {
  it('has feature-slice step 5 call ui-verifier for UI changes', () => {
    const verify = section(read('.claude/skills/feature-slice/SKILL.md'), '5. Verify');

    expect(verify).toContain('ui-verifier');
  });

  it('lists the ui-verifier agent and the e2e-flow skill in the CLAUDE.md Harness section', () => {
    const harness = section(read('CLAUDE.md'), 'Harness');

    expect(harness).toContain('ui-verifier');
    expect(harness).toContain('e2e-flow');
  });

  it('records the change in the ADR 0003 amendment, naming ui-verifier and e2e-flow', () => {
    const amendments = adrAmendments();

    // The amendment already names ui-verifier as a future addition;
    // e2e-flow appears nowhere in the ADR yet, so it proves the change.
    expect(amendments).toContain('ui-verifier');
    expect(amendments).toContain('e2e-flow');
  });
});
