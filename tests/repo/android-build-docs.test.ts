/**
 * @jest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SMOKE_DOC = path.join(ROOT, 'docs', 'mobile-smoke-test.md');
const PLAN = path.join(ROOT, 'docs', 'plan', 'mvp-implementation-plan.md');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

function smokeDoc(): string {
  if (!existsSync(SMOKE_DOC)) throw new Error('docs/mobile-smoke-test.md does not exist');
  return readFileSync(SMOKE_DOC, 'utf8');
}

// The workflow that runs `eas build` (see android-build-workflow.test.ts).
function buildWorkflowName(): string | undefined {
  return readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .find((name) =>
      /^(?!\s*#).*(?:\beas|eas-cli@\S+|\$\{?eas\}?)\s+build\b/m.test(
        readFileSync(path.join(WORKFLOWS, name), 'utf8'),
      ),
    );
}

function section(text: string, heading: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`no heading matching ${heading}`);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('docs/mobile-smoke-test.md', () => {
  it('tells how to dispatch the APK build workflow', () => {
    const match = /gh workflow run\s+["']?([\w.-]+)/.exec(smokeDoc());

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(buildWorkflowName());
  });

  it('tells how to build and start the development client', () => {
    const doc = smokeDoc();

    expect(doc).toMatch(/npx expo start/);
    expect(doc).toMatch(/--profile[\s=]development|expo run:android/);
  });

  it('has the smoke checklist: install, open a category, play a quiz, see the result, switch language', () => {
    const items = smokeDoc()
      .split(/\r?\n/)
      .map((line) => /^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]?\]\s+)?(.+)$/.exec(line)?.[1])
      .filter((item): item is string => item !== undefined);

    for (const step of [/install/i, /categor/i, /\bplay\b|quiz/i, /result/i, /language|sprache/i]) {
      expect(items.filter((item) => step.test(item)).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('explains how a phone reaches the local Supabase stack', () => {
    const doc = smokeDoc();

    expect(doc).toMatch(/adb reverse/);
    expect(doc).toMatch(/\.env\.local/);
  });

  it('names eas init as a one-time step for the human', () => {
    expect(smokeDoc()).toMatch(/eas init/);
  });
});

describe('CLAUDE.md', () => {
  it('links the mobile smoke test from the Commands section', () => {
    const commands = section(readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'), /^## Commands/);

    expect(commands).toMatch(/\]\(docs\/mobile-smoke-test\.md\)/);
  });
});

describe('the plan records the Android build path', () => {
  function decisionRows(): string[] {
    return section(readFileSync(PLAN, 'utf8'), /^## 7\. Decisions/)
      .split('\n')
      .filter((line) => line.startsWith('|'));
  }

  it('has a decision row for building with eas build --local through workflow_dispatch', () => {
    expect(
      decisionRows().some((row) => /eas build --local/.test(row) && /workflow_dispatch/.test(row)),
    ).toBe(true);
  });

  it('lists EXPO_TOKEN among the hosted credentials', () => {
    const row = decisionRows().find((line) => /^\|\s*Hosted credentials\s*\|/.test(line));

    expect(row).toBeDefined();
    expect(row).toMatch(/EXPO_TOKEN/);
  });
});
