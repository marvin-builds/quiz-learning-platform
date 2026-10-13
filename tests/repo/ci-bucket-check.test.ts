/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #124 (S7): after migrating the hosted database and pushing its config, and
// before the deploy, CI compares the hosted quiz-images bucket with the
// expected values through scripts/check-quiz-images-bucket.mjs (unit-tested
// in check-quiz-images-bucket.test.ts) and fails on a difference.
//
// The Management API's GET /v1/projects/{ref}/storage/buckets returns only
// id, name, owner, created_at, updated_at and public (its OpenAPI schema
// V1StorageBucketResponse), so it can't show the limits: CI must read the
// row of storage.buckets itself, with the secrets the deploy job already has.

const WORKFLOW = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');
const SCRIPT = 'scripts/check-quiz-images-bucket.mjs';
const DEPLOY_SECRETS = [
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_PUBLISHABLE_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
];

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

// The job that migrates the hosted database, found by its command.
function deployJob(): { job: string; steps: string[] } {
  const matching = jobs(readFileSync(WORKFLOW, 'utf8')).filter((job) =>
    /\bsupabase db push\b/.test(job),
  );
  expect(matching).toHaveLength(1);
  return { job: matching[0], steps: steps(matching[0]) };
}

// Index of the first step whose text matches; within a step, commands run in
// order, so a position inside the step's text breaks ties.
function position(all: string[], pattern: RegExp): [number, number] {
  for (const [index, step] of all.entries()) {
    const match = pattern.exec(step);
    if (match) return [index, match.index];
  }
  throw new Error(`the deploy job has no step matching ${pattern}`);
}

const before = (a: [number, number], b: [number, number]) =>
  a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

function checkStep(): string {
  const { steps: all } = deployJob();
  const found = all.filter((step) => step.includes(SCRIPT));
  expect(found).toHaveLength(1);
  return found[0];
}

describe('CI checks the hosted quiz-images bucket', () => {
  it('runs the bucket check in the deploy job', () => {
    expect(checkStep()).toMatch(new RegExp(`\\bnode\\s+(\\S+\\s+)*${SCRIPT.replace('.', '\\.')}`));
  });

  it('checks after the migration and the config push and before the deploy', () => {
    const { steps: all } = deployJob();
    const check = position(all, new RegExp(SCRIPT.replace('.', '\\.')));

    expect(before(position(all, /\bsupabase db push\b/), check)).toBe(true);
    expect(before(position(all, /\bsupabase config push\b/), check)).toBe(true);
    expect(before(check, position(all, /\bpages deploy\b/))).toBe(true);
  });

  it('feeds it the row of storage.buckets with the limits, not the Management API bucket list', () => {
    // The query may run in the check's step or in an earlier step of the job
    // that writes the row to a file; either way one step names the table and
    // all three columns, after the migration and no later than the check.
    const { job, steps: all } = deployJob();
    const isQuery = (step: string) =>
      /\bstorage\.buckets\b/.test(step) &&
      /\bfile_size_limit\b/.test(step) &&
      /\ballowed_mime_types\b/.test(step) &&
      /\bpublic\b/.test(step);
    const query = all.findIndex(isQuery);
    const check = all.findIndex((step) => step.includes(SCRIPT));

    expect(query).toBeGreaterThanOrEqual(0);
    expect(query).toBeGreaterThanOrEqual(position(all, /\bsupabase db push\b/)[0]);
    expect(check).toBeGreaterThanOrEqual(query);
    expect(job).not.toMatch(/\/v1\/projects\/[^\s"']*\/storage\/buckets/);
  });

  it('uses only secrets the deploy job already has', () => {
    const used = [...checkStep().matchAll(/secrets\.(\w+)/g)].map((match) => match[1]);
    for (const secret of used) expect(DEPLOY_SECRETS).toContain(secret);
  });

  it('lets a failed check fail the job', () => {
    const step = checkStep();

    expect(step).not.toMatch(/continue-on-error:\s*true/);
    expect(step).not.toMatch(/\|\|\s*(true|:)\s*$/m);
    expect(step).not.toMatch(/\bset \+e\b/);
  });

  it('no longer checks only that the bucket is public', () => {
    // The old jq filter accepted any quiz-images bucket that is public.
    expect(deployJob().job).not.toMatch(/select\(\.id == "quiz-images" and \.public == true\)/);
  });
});
