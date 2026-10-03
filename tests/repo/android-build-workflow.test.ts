/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.join(process.cwd(), '.github', 'workflows');

// A non-comment line that runs `eas build`, directly, through a pinned
// `eas-cli@x.y.z` or through a shell variable named eas.
const EAS_BUILD = /^(?!\s*#).*(?:\beas|eas-cli@\S+|\$\{?eas\}?)\s+build\b/m;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
}

function read(name: string): string {
  return readFileSync(path.join(WORKFLOWS, name), 'utf8');
}

function buildWorkflowName(): string {
  const matching = workflowFiles().filter((name) => EAS_BUILD.test(read(name)));
  expect(matching).toHaveLength(1);
  return matching[0];
}

function buildWorkflow(): string {
  return read(buildWorkflowName());
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

// Jobs of the workflow, each from its `  <name>:` line up to the next job.
function jobs(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start === -1) throw new Error('the workflow has no jobs');
  const bodies: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) bodies.push(line);
    else if (/^\S/.test(line)) break;
    else if (bodies.length > 0) bodies[bodies.length - 1] += `\n${line}`;
  }
  return bodies;
}

// The job's own settings: everything before its `steps:` line.
function jobHeader(job: string): string {
  return job.split(/\n(?= {4}steps:)/)[0];
}

// Steps of a job, each starting at its `- ` line.
function steps(job: string): string[] {
  return job.split(/\n(?= {6}- )/).slice(1);
}

function buildJob(): string {
  const matching = jobs(buildWorkflow()).filter((job) => EAS_BUILD.test(job));
  expect(matching).toHaveLength(1);
  return matching[0];
}

function buildStepIndex(all: string[]): number {
  const index = all.findIndex((step) => EAS_BUILD.test(step));
  if (index === -1) throw new Error('the build job has no eas build step');
  return index;
}

describe('the manual Android build workflow', () => {
  it('is a separate workflow file, and ci.yml runs no eas build', () => {
    expect(buildWorkflowName()).not.toBe('ci.yml');
    expect(read('ci.yml')).not.toMatch(EAS_BUILD);
  });

  it('runs only when dispatched by hand', () => {
    const on = topLevelBlock(buildWorkflow(), 'on') ?? '';
    const inline = on.split('\n')[0].trim();
    const triggers = inline
      ? inline.replace(/^\[|\]$/g, '').split(/\s*,\s*/)
      : [...on.matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1]);

    expect(triggers).toEqual(['workflow_dispatch']);
  });

  it('grants the token only read access to the repository contents', () => {
    const permissions = topLevelBlock(buildWorkflow(), 'permissions') ?? '';

    expect(permissions).toMatch(/^\s*contents:\s*read\s*$/m);
    expect(permissions).not.toMatch(/\bwrite(?:-all)?\b/);
    for (const job of jobs(buildWorkflow())) {
      // The job's `permissions:` line and the deeper-indented lines below it.
      const jobPermissions = /^ {4}permissions:.*(?:\n {6,}.*)*/m.exec(jobHeader(job))?.[0] ?? '';
      expect(jobPermissions).not.toMatch(/\bwrite(?:-all)?\b/);
    }
  });

  it('runs the build in the production environment, which holds the secrets', () => {
    expect(jobHeader(buildJob())).toMatch(
      /^ {4}environment:\s*(?:production\s*$|\n\s+name:\s*production\s*$)/m,
    );
  });

  it('builds the preview APK for Android locally on the runner with a pinned eas-cli', () => {
    const step = steps(buildJob())[buildStepIndex(steps(buildJob()))];

    expect(step).toMatch(/\s--local\b/);
    expect(step).toMatch(/\s(?:-p|--platform)[\s=]android\b/);
    expect(step).toMatch(/\s--profile[\s=]preview\b/);
    expect(step).toMatch(/\beas-cli@\d+\.\d+\.\d+(?![\w.-])/);
  });

  it('passes the Expo token and the publishable key to the build step only', () => {
    const workflow = buildWorkflow();
    const job = buildJob();
    const step = steps(job)[buildStepIndex(steps(job))];

    expect(step).toMatch(/^\s*EXPO_TOKEN:\s*\$\{\{\s*secrets\.EXPO_TOKEN\s*\}\}\s*$/m);
    expect(step).toMatch(
      /^\s*EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:\s*\$\{\{\s*secrets\.SUPABASE_PUBLISHABLE_KEY\s*\}\}\s*$/m,
    );
    expect(topLevelBlock(workflow, 'env') ?? '').not.toMatch(/secrets\./);
    for (const each of jobs(workflow)) {
      expect(jobHeader(each)).not.toMatch(/secrets\./);
      for (const other of steps(each).filter((candidate) => candidate !== step)) {
        expect(other).not.toMatch(/secrets\./);
      }
    }
  });

  it('keeps the committed .env with the local stack out of the build', () => {
    const workflow = buildWorkflow();
    const job = buildJob();
    const step = steps(job)[buildStepIndex(steps(job))];
    const effective = [topLevelBlock(workflow, 'env') ?? '', jobHeader(job), step].join('\n');

    expect(
      /^\s*EXPO_NO_DOTENV:\s*["']?1["']?\s*$/m.test(effective) ||
        /\bEXPO_NO_DOTENV=["']?1["']?\s/.test(step),
    ).toBe(true);
  });

  it('checks after the build that the APK bundle has the hosted URL and not 127.0.0.1', () => {
    const all = steps(buildJob());
    const build = buildStepIndex(all);
    const check = all.findIndex(
      (step, index) =>
        index > build &&
        /\.apk\b|index\.android\.bundle|unzip/i.test(step) &&
        /^(?=.*\bgrep\b).*127\\?\.0\\?\.0\\?\.1/m.test(step) &&
        /kiywcqhicsesgknlwjyy|SUPABASE_URL|SUPABASE_PROJECT_REF/.test(step),
    );

    expect(check).toBeGreaterThan(build);
  });

  it('uploads the APK as an artifact after the build', () => {
    const all = steps(buildJob());
    const build = buildStepIndex(all);
    const upload = all.findIndex(
      (step, index) =>
        index > build && /uses:\s*actions\/upload-artifact@/.test(step) && /apk/i.test(step),
    );

    expect(upload).toBeGreaterThan(build);
  });
});
