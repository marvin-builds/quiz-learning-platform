/**
 * @jest-environment node
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// One export command for every path (#123): the deploy job and the e2e web
// server both build with `npm run export:web`, which runs the Expo web export
// and then writes dist/_headers (scripts/security-headers.mjs). A bare
// `expo export` anywhere else would ship or test a build without the headers.

const ROOT = process.cwd();
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const CI = path.join(WORKFLOWS, 'ci.yml');

type PackageJson = { scripts?: Record<string, string> };
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;

const EXPORT_WEB = /\bexpo export\b[^;&|]*(?:-p|--platform)[ =]web\b/;
const GENERATOR = /\bnode scripts\/security-headers\.mjs\b/;
const RUNS_EXPORT_WEB = /\bnpm run (?:-s |--silent )?export:web\b/;

// Jobs of a workflow, each from its `  <name>:` line up to the next job.
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

function deployJob(): string {
  const matching = jobs(readFileSync(CI, 'utf8')).filter((job) =>
    /\bwrangler\S* pages deploy dist\b/.test(job),
  );
  expect(matching).toHaveLength(1);
  return matching[0];
}

// The webServer commands of playwright.config.ts, read by a plain Node
// process with the project's TypeScript (see e2e-harness-playwright-config).
function webServerCommands(): string[] {
  const file = path.join(ROOT, 'playwright.config.ts');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const ts = require('typescript');
    const file = ${JSON.stringify(file)};
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__filename', '__dirname', outputText)(
      createRequire(file), mod, mod.exports, file, path.dirname(file),
    );
    const config = mod.exports.default ?? mod.exports;
    process.stdout.write(JSON.stringify([config.webServer ?? []].flat().map((s) => s.command ?? '')));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' }),
  ) as string[];
}

describe('the export:web script', () => {
  it('runs the Expo web export and then writes dist/_headers', () => {
    const command = pkg.scripts?.['export:web'] ?? '';

    expect(command).toMatch(EXPORT_WEB);
    expect(command).toMatch(GENERATOR);
    const afterExport = command.slice(command.search(EXPORT_WEB));
    // Only after a successful export, so a failed export leaves no headers behind.
    expect(afterExport).toMatch(new RegExp(`&&[^;|]*${GENERATOR.source}`));
  });
});

describe('every web export goes through export:web', () => {
  it('deploys the output of npm run export:web to Cloudflare Pages', () => {
    const job = deployJob();
    const exportAt = job.search(RUNS_EXPORT_WEB);

    expect(exportAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(job.search(/\bwrangler\S* pages deploy dist\b/));
  });

  it('runs no bare expo export in any workflow', () => {
    const bare = readdirSync(WORKFLOWS)
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) => /\bexpo export\b/.test(readFileSync(path.join(WORKFLOWS, name), 'utf8')));

    expect(bare).toEqual([]);
  });

  it('builds the e2e web server with npm run export:web', () => {
    const commands = webServerCommands();

    expect(commands.some((command) => RUNS_EXPORT_WEB.test(command))).toBe(true);
    expect(commands.filter((command) => /\bexpo export\b/.test(command))).toEqual([]);
  });
});

describe('the docs name where the headers come from', () => {
  it('lists npm run export:web under Commands in CLAUDE.md', () => {
    const text = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    const start = text.search(/^## Commands\s*$/m);
    expect(start).toBeGreaterThan(-1);
    const rest = text.slice(start + 3);
    const section = rest.slice(0, rest.search(/^## /m));

    expect(section).toMatch(RUNS_EXPORT_WEB);
  });

  it('records the generated _headers and its env-derived Supabase host in the plan decisions', () => {
    const text = readFileSync(
      path.join(ROOT, 'docs', 'plan', 'mvp-implementation-plan.md'),
      'utf8',
    );
    const start = text.search(/^## \d+\. Decisions\s*$/m);
    expect(start).toBeGreaterThan(-1);
    const rows = text
      .slice(start)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('|'));

    expect(
      rows.some(
        (row) =>
          /_headers/.test(row) &&
          /scripts\/security-headers\.mjs/.test(row) &&
          /EXPO_PUBLIC_SUPABASE_URL/.test(row),
      ),
    ).toBe(true);
  });
});
