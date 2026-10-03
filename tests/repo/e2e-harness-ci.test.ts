/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOW = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');

// Jobs of the workflow, each from its `  <name>:` line up to the next job.
function jobs(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start === -1) throw new Error('ci.yml has no jobs');
  const bodies: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) bodies.push(line);
    else if (/^\S/.test(line)) break;
    else if (bodies.length > 0) bodies[bodies.length - 1] += `\n${line}`;
  }
  return bodies;
}

// Steps of a job, each starting at its `- ` line.
function steps(job: string): string[] {
  return job.split(/\n(?= {6}- )/).slice(1);
}

// The job that runs the e2e tests, found by its command so its name stays free.
function e2eJob(): string[] {
  const matching = jobs(readFileSync(WORKFLOW, 'utf8')).filter((job) =>
    /^\s*(?:-\s+)?run:.*\bnpm run test:e2e\b/m.test(job),
  );
  expect(matching).toHaveLength(1);
  return steps(matching[0]);
}

function indexOfStep(all: string[], pattern: RegExp): number {
  const index = all.findIndex((step) => pattern.test(step));
  if (index === -1) throw new Error(`the e2e job has no step matching ${pattern}`);
  return index;
}

describe('CI runs the e2e tests', () => {
  it('runs npm run test:e2e in exactly one job', () => {
    expect(e2eJob().length).toBeGreaterThan(0);
  });

  it('starts the local stack without leaving out auth, the REST API or the gateway', () => {
    const all = e2eJob();
    const start = all[indexOfStep(all, /\bsupabase start\b/)];
    const command = /\bsupabase start\b.*$/m.exec(start)?.[0] ?? '';
    const excluded = [...command.matchAll(/(?:-x|--exclude)(?:\s+|=)(\S+)/g)].flatMap((match) =>
      match[1].split(','),
    );

    for (const service of ['gotrue', 'postgrest', 'kong']) {
      expect(excluded).not.toContain(service);
    }
  });

  it('resets the database after starting the stack and before the tests', () => {
    const all = e2eJob();
    const start = indexOfStep(all, /\bsupabase start\b/);
    const reset = indexOfStep(all, /\bsupabase db reset\b/);
    const tests = indexOfStep(all, /\bnpm run test:e2e\b/);

    expect(start).toBeLessThan(reset);
    expect(reset).toBeLessThan(tests);
  });

  it('installs Chromium with its system dependencies before the tests', () => {
    const all = e2eJob();
    const install = indexOfStep(all, /\bnpx playwright install\b/);
    const command = /\bnpx playwright install\b.*$/m.exec(all[install])?.[0] ?? '';

    expect(command).toMatch(/\s--with-deps\b/);
    expect(command).toMatch(/\schromium\b/);
    expect(command).not.toMatch(/\b(firefox|webkit|chrome|msedge)\b/);
    expect(install).toBeLessThan(indexOfStep(all, /\bnpm run test:e2e\b/));
  });

  it('uploads the Playwright traces and screenshots as an artifact when a test fails', () => {
    const all = e2eJob();
    const upload = indexOfStep(all, /uses:\s*actions\/upload-artifact@/);
    const step = all[upload];

    expect(upload).toBeGreaterThan(indexOfStep(all, /\bnpm run test:e2e\b/));
    expect(step).toMatch(/^\s*if:\s*(?:\$\{\{\s*)?(?:failure\(\)|always\(\)|!cancelled\(\))/m);
    expect(step).toMatch(/\b(test-results|playwright-report)\b/);
  });
});
