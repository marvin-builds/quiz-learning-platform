/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOW = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');

// The body of one job: from its `  <name>:` line up to the next job.
function jobBody(workflow: string, job: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) throw new Error(`ci.yml has no job "${job}"`);
  const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

// Steps of a job, each starting at its `- ` line.
function steps(body: string): string[] {
  return body.split(/\n(?= {6}- )/).slice(1);
}

describe('CI rejects PR branches that contain merge commits', () => {
  const app = jobBody(readFileSync(WORKFLOW, 'utf8'), 'app');

  it('runs the check in a required job, on pull requests only', () => {
    const check = steps(app).find((step) => step.includes('git log --merges'));
    expect(check).toBeDefined();
    expect(check).toMatch(/if:\s*github\.event_name == 'pull_request'/);
  });

  it('looks at the PR head, not the merge ref GitHub checks out', () => {
    const check = steps(app).find((step) => step.includes('git log --merges')) ?? '';
    expect(check).toContain(
      'origin/${{ github.base_ref }}..${{ github.event.pull_request.head.sha }}',
    );
  });

  it('fetches the full history so the base branch is there to compare', () => {
    const checkout = steps(app).find((step) => step.includes('actions/checkout')) ?? '';
    expect(checkout).toMatch(/fetch-depth:\s*0/);
  });
});
