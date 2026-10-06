/**
 * @jest-environment node
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(process.cwd(), 'playwright.config.ts');

type WebServer = { command?: string; url?: string; port?: number };
type Config = { use?: { baseURL?: string }; webServer?: WebServer | WebServer[] };

// Evaluated like in e2e-harness-playwright-config.test.ts, but from `cwd`,
// since Playwright runs from the checkout whose .env.local counts.
function loadConfig(cwd: string): Config {
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    const file = ${JSON.stringify(CONFIG)};
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__filename', '__dirname', outputText)(
      createRequire(file), mod, mod.exports, file, path.dirname(file),
    );
    process.stdout.write(JSON.stringify(mod.exports.default ?? mod.exports));
  `;
  const env = { ...process.env };
  delete env.QUIZ_E2E_PORT;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8' }));
}

function exportServer(config: Config): WebServer | undefined {
  return [config.webServer ?? []].flat().find((s) => /\bexpo export\b/.test(s.command ?? ''));
}

describe('playwright.config.ts port', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-port-')));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('serves and tests on the worktree port from QUIZ_E2E_PORT in .env.local', () => {
    fs.writeFileSync(
      path.join(dir, '.env.local'),
      'EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54421\nQUIZ_E2E_PORT=4273\n',
    );

    const config = loadConfig(dir);

    expect(config.use?.baseURL).toBe('http://127.0.0.1:4273');
    const server = exportServer(config);
    expect(server?.url ?? `http://127.0.0.1:${server?.port}`).toBe('http://127.0.0.1:4273');
    expect(server?.command).toContain('127.0.0.1:4273');
    expect(server?.command).not.toContain('4173');
  });

  it.each([
    ['without .env.local', undefined],
    [
      'when .env.local has no QUIZ_E2E_PORT',
      'EXPO_PUBLIC_SUPABASE_URL=http://192.168.1.20:54321\n',
    ],
  ])('keeps the default port 4173 %s', (_label, content) => {
    if (content !== undefined) fs.writeFileSync(path.join(dir, '.env.local'), content);

    const config = loadConfig(dir);

    expect(config.use?.baseURL).toBe('http://127.0.0.1:4173');
    expect(exportServer(config)?.command).toContain('127.0.0.1:4173');
  });
});
