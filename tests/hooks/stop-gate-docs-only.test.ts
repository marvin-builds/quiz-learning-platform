/**
 * @jest-environment node
 */
import fs from 'node:fs';
import { Fixture, writeTypeScriptProject } from './fixture';

jest.setTimeout(60_000);

const HOOK = 'stop-gate.mjs';
const CAP = { QUIZ_STOP_CAP: '2' };

function baseProject(fixture: Fixture): void {
  writeTypeScriptProject(fixture);
  fixture.write('package.json', JSON.stringify({ jest: { testEnvironment: 'node' } }));
  fixture.write('README.md', '# Project\n');
  fixture.write('src/sum.js', 'module.exports = (a, b) => a + b;\n');
  fixture.write(
    'src/sum.test.js',
    "const sum = require('./sum');\ntest('adds', () => expect(sum(1, 2)).toBe(3));\n",
  );
  fixture.write('.github/workflows/ci.yml', 'name: CI\n');
  fixture.commitAll();
}

function stop(fixture: Fixture) {
  return fixture.runHook(HOOK, { hook_event_name: 'Stop', stop_hook_active: false }, CAP);
}

// Only Markdown, `.github/` and `docs/` changed: there is nothing for Jest or
// tsc to check, so the gate doesn't run them and a checkout without
// node_modules isn't held up. Any other changed file runs the checks.
describe('stop-gate hook on a branch that changes only docs or GitHub config', () => {
  let fixture: Fixture;

  beforeEach(() => {
    // Without node_modules, running Jest or tsc would report a setup problem.
    fixture = new Fixture({ nodeModules: false });
    baseProject(fixture);
    fixture.markAsOriginMain();
  });

  afterEach(() => {
    fixture.remove();
  });

  function expectPassWithoutChecks(result: ReturnType<typeof stop>): void {
    expect(result.status).toBe(0);
    expect(result.output?.decision).toBeUndefined();
    expect(result.stdout).not.toMatch(/setup problem|could not be started|npm ci/i);
  }

  function expectSetupProblem(result: ReturnType<typeof stop>): void {
    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toMatch(/setup problem/i);
    expect(result.output?.reason).toContain(`could not be started in ${fixture.dir}`);
  }

  it('lets the agent stop on a docs-only branch without running the checks', () => {
    fixture.write('README.md', '# Project\n\nMore.\n');
    fixture.write('docs/x.md', '# X\n');
    fixture.commitAll('document x');
    fixture.write('CHANGELOG.md', '# Changelog\n');

    expectPassWithoutChecks(stop(fixture));
  });

  it('lets the agent stop on a config-only branch without running the checks', () => {
    fixture.write('.github/workflows/ci.yml', 'name: CI\non: push\n');
    fixture.write('.github/dependabot.yml', 'version: 2\n');
    fixture.commitAll('configure dependabot');

    expectPassWithoutChecks(stop(fixture));
  });

  it('lets the agent stop on a branch without any changes without running the checks', () => {
    expectPassWithoutChecks(stop(fixture));
  });

  it.each([
    'src/notes.md',
    '.claude/skills/feature-slice/SKILL.md',
    'docs/diagram.svg',
    'docs/plan/overview.md',
    '.github/ISSUE_TEMPLATE/bug.yml',
  ])('lets the agent stop when the only change is %s', (relative) => {
    fixture.write(relative, 'changed\n');

    expectPassWithoutChecks(stop(fixture));
  });

  it.each<[string, (f: Fixture) => void]>([
    ['a change to src/sum.js', (f) => f.write('src/sum.js', 'module.exports = (a, b) => b + a;\n')],
    [
      'a committed change to src/sum.js',
      (f) => {
        f.write('src/sum.js', 'module.exports = (a, b) => b + a;\n');
        f.commitAll('change sum');
      },
    ],
    [
      'a change to src/sum.test.js',
      (f) =>
        f.write(
          'src/sum.test.js',
          "const sum = require('./sum');\ntest('adds two', () => expect(sum(2, 2)).toBe(4));\n",
        ),
    ],
    ['a change to package.json', (f) => f.write('package.json', JSON.stringify({ private: true }))],
    ['a change to tsconfig.json', (f) => f.write('tsconfig.json', JSON.stringify({}))],
    ['an untracked src/new.ts', (f) => f.write('src/new.ts', 'export const n = 1;\n')],
    ['a deleted src/sum.js', (f) => fs.rmSync(f.path('src/sum.js'))],
    ['an untracked jest.config.js', (f) => f.write('jest.config.js', 'module.exports = {};\n')],
    ['an untracked notes.txt', (f) => f.write('notes.txt', 'notes\n')],
    ['an untracked src/docs/helper.ts', (f) => f.write('src/docs/helper.ts', 'export {};\n')],
  ])('runs the checks as before on a mixed branch with %s', (_label, change) => {
    fixture.write('README.md', '# Project\n\nMore.\n');
    fixture.commitAll('document');
    change(fixture);

    expectSetupProblem(stop(fixture));
  });
});

describe('stop-gate hook on a branch that mixes docs with code', () => {
  let fixture: Fixture;

  afterEach(() => {
    fixture.remove();
  });

  it('blocks for a failing test when production code broke next to a Markdown change', () => {
    fixture = new Fixture();
    baseProject(fixture);
    fixture.markAsOriginMain();
    fixture.write('README.md', '# Project\n\nMore.\n');
    fixture.write('src/sum.js', 'module.exports = (a, b) => a - b;\n');

    const result = stop(fixture);

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toContain('src/sum.test.js');
  });

  it('runs the checks as before when there is no origin/main to compare with', () => {
    fixture = new Fixture({ nodeModules: false });
    baseProject(fixture);
    fixture.write('README.md', '# Project\n\nMore.\n');

    const result = stop(fixture);

    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason).toMatch(/setup problem/i);
  });
});
