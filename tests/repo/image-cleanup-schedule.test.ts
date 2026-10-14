/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The scheduled image cleanup (#125), as the repository wires it up:
//
// - A GitHub Actions workflow runs `node scripts/clean-up-images.mjs` on a
//   schedule (and by hand), never on pushes or PRs. The script needs a
//   Supabase secret key, which can't be scoped to one bucket, so it lives only
//   as a GitHub Actions secret, passed to the one step that runs the script,
//   never to the workflow or job as a whole. Adding that
//   secret on GitHub is a human step listed in the PR; nothing here reaches
//   the hosted project from the dev machine.
// - The cleanup's integration test (tests/stack/*.stack.test.ts) needs the
//   local stack, so `npm test` leaves it out, `npm run test:stack` runs it,
//   and CI runs that in the database job after starting the stack.
// - The plan's Images row and removeImages' doc comment no longer call
//   orphans accepted and cleaned up by hand: a failed removal is reported and
//   a scheduled cleanup removes what stays after a grace period.

const ROOT = process.cwd();
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const SCRIPT = 'scripts/clean-up-images.mjs';
const STACK_TEST = 'tests/stack/clean-up-images.stack.test.ts';

const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

// A non-comment line that runs the cleanup script with node.
const RUNS_SCRIPT = /^(?!\s*#).*\bnode\s+(?:\.\/)?scripts\/clean-up-images\.mjs\b/m;

function cleanupWorkflow(): string {
  const matching = readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => RUNS_SCRIPT.test(readFileSync(path.join(WORKFLOWS, name), 'utf8')));
  expect(matching).toEqual([expect.any(String)]);
  return readFileSync(path.join(WORKFLOWS, matching[0]), 'utf8');
}

// A top-level block (`<key>:` up to the next top-level line), without its key line.
function topLevelBlock(workflow: string, key: string): string | undefined {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start === -1) return undefined;
  const body = [lines[start].replace(new RegExp(`^${key}:\\s*`), '')];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

const withoutComments = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

// The steps of every job: each from its `      - ` line up to the next step
// or the end of the job.
function steps(workflow: string): string[] {
  const result: string[] = [];
  let inSteps = false;
  for (const line of workflow.split(/\r?\n/)) {
    if (/^ {4}steps:\s*$/.test(line)) inSteps = true;
    else if (/^ {0,4}\S/.test(line)) inSteps = false;
    else if (inSteps && /^ {6}- /.test(line)) result.push(line);
    else if (inSteps && result.length > 0) result[result.length - 1] += `\n${line}`;
  }
  return result;
}

// Jobs of a workflow, each from its `  <name>:` line up to the next job.
function jobs(workflow: string): Map<string, string> {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start === -1) throw new Error('the workflow has no jobs');
  const bodies = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines.slice(start + 1)) {
    const job = /^ {2}([\w-]+):/.exec(line);
    if (job) {
      current = job[1];
      bodies.set(current, line);
    } else if (/^\S/.test(line)) break;
    else if (current) bodies.set(current, `${bodies.get(current)}\n${line}`);
  }
  return bodies;
}

describe('scheduled image cleanup: workflow', () => {
  it('a workflow runs the cleanup script', () => {
    expect(cleanupWorkflow()).toMatch(RUNS_SCRIPT);
  });

  it('runs on a schedule and by hand, never on pushes or pull requests', () => {
    const on = withoutComments(topLevelBlock(cleanupWorkflow(), 'on') ?? '');
    expect(on).toMatch(/\bschedule:/);
    expect(on).toMatch(/-\s*cron:\s*['"][^'"]+['"]/);
    expect(on).toMatch(/\bworkflow_dispatch\b/);
    expect(on).not.toMatch(/\bpull_request(_target)?\b/);
    expect(on).not.toMatch(/\bpush\b/);
  });

  it('may only read the repository contents', () => {
    const permissions = withoutComments(topLevelBlock(cleanupWorkflow(), 'permissions') ?? '');
    const granted = permissions
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(granted).toEqual(['contents: read']);
  });

  it('passes the secret key only to the step that runs the script, as SUPABASE_SECRET_KEY, with SUPABASE_URL', () => {
    const workflow = cleanupWorkflow();
    const all = steps(workflow);
    const running = all.filter((step) => RUNS_SCRIPT.test(step));
    expect(running).toHaveLength(1);
    const [step] = running;
    expect(step).toMatch(/^\s+env:\s*$/m);
    expect(step).toMatch(/^\s+SUPABASE_SECRET_KEY:\s*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}\s*$/m);
    expect(step).toMatch(/^\s+SUPABASE_URL:\s*\S+/m);

    // No other place in the workflow names a secret.
    const secretLines = withoutComments(workflow)
      .split(/\r?\n/)
      .filter((line) => /\bsecrets\./.test(line));
    const inStep = withoutComments(step)
      .split(/\r?\n/)
      .filter((line) => /\bsecrets\./.test(line));
    expect(secretLines).toEqual(inStep);
    expect(withoutComments(topLevelBlock(workflow, 'env') ?? '')).not.toMatch(/secrets\./);
  });

  it('runs the script with no --now and no other argument (the clock override stays test-only)', () => {
    const running = steps(cleanupWorkflow()).filter((step) => RUNS_SCRIPT.test(step));
    expect(running).toHaveLength(1);
    const body = withoutComments(running[0]);
    expect(body).not.toMatch(/--now\b/);
    const invocations = body
      .split(/\r?\n/)
      .filter((line) => /\bnode\s+(?:\.\/)?scripts\/clean-up-images\.mjs\b/.test(line));
    expect(invocations).toHaveLength(1);
    // Whatever follows the script name on its line: nothing but an optional closing quote.
    const rest = invocations[0]
      .replace(/^.*?\bnode\s+(?:\.\/)?scripts\/clean-up-images\.mjs/, '')
      .trim();
    expect(rest).toMatch(/^['"]?$/);
  });
});

describe('scheduled image cleanup: its integration test runs locally and in CI', () => {
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
    jest: { testPathIgnorePatterns?: string[] };
  };

  it('`npm test` leaves the stack test out', () => {
    const ignored = (pkg.jest.testPathIgnorePatterns ?? []).some((pattern) =>
      new RegExp(pattern.replace('<rootDir>', ROOT)).test(path.join(ROOT, STACK_TEST)),
    );
    expect(ignored).toBe(true);
  });

  it('`npm run test:stack` runs the stack tests', () => {
    expect(pkg.scripts['test:stack']).toEqual(expect.stringMatching(/\bjest\b.*stack/));
  });

  it('CI runs `npm run test:stack` in the database job, after starting the stack', () => {
    const db = jobs(read('.github/workflows/ci.yml')).get('db');
    expect(db).toBeDefined();
    const body = withoutComments(db ?? '');
    const start = body.search(/npx supabase start\b/);
    const run = body.search(/npm run test:stack\b/);
    expect(start).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(start);
  });

  it('the cleanup script exists where the workflow and the stack test call it', () => {
    expect(() => read(SCRIPT)).not.toThrow();
  });
});

describe('scheduled image cleanup: docs', () => {
  function imagesRow(): string {
    const row = read('docs/plan/mvp-implementation-plan.md')
      .split(/\r?\n/)
      .find((line) => /^\|\s*Images\s*\|/.test(line));
    if (!row) throw new Error('the plan has no Images row in its decisions table');
    return row;
  }

  it('the plan’s Images row names the scheduled cleanup and its grace period instead of cleaning up by hand', () => {
    const row = imagesRow();
    expect(row).not.toMatch(/by hand or with a later scheduled job/i);
    expect(row).toMatch(/grace period/i);
    expect(row).toMatch(/clean-up-images/);
    expect(row).toMatch(/schedul/i);
  });

  it('the plan’s Images row says the admin is told when a removal fails', () => {
    expect(imagesRow()).toMatch(/(admin|editor)[^|]*(told|notice|report)/i);
  });

  it('removeImages no longer documents a failed removal as best effort and not a failure', () => {
    const source = read('src/lib/images.ts');
    expect(source).not.toMatch(/best effort/i);
    expect(source).not.toMatch(/not a failure of the save/i);
  });
});
