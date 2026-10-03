/**
 * @jest-environment node
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG = path.join(ROOT, 'playwright.config.ts');

type Use = {
  browserName?: string;
  channel?: string;
  locale?: string;
  viewport?: { width: number; height: number } | null;
  baseURL?: string;
  trace?: string | { mode: string };
  screenshot?: string | { mode: string };
};
type Project = { name?: string; use?: Use };
type WebServer = { command?: string; url?: string; port?: number };
type Config = {
  testDir?: string;
  use?: Use;
  projects?: Project[];
  webServer?: WebServer | WebServer[];
};

// The config is TypeScript that imports @playwright/test, so it is transpiled
// with the project's TypeScript and evaluated by a plain Node process (Jest's
// module VM would get in the way), which prints it as JSON.
function loadConfig(): Config {
  if (!existsSync(CONFIG)) {
    throw new Error(`${path.relative(ROOT, CONFIG)} does not exist`);
  }
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const ts = require('typescript');
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
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' }),
  );
}

function effectiveUse(config: Config, project: Project): Use {
  return { ...config.use, ...project.use };
}

function mode(option: Use['trace']): string | undefined {
  return typeof option === 'object' ? option.mode : option;
}

describe('playwright.config.ts', () => {
  let config: Config;

  beforeAll(() => {
    config = loadConfig();
  });

  it('looks for tests in e2e/', () => {
    expect(path.resolve(ROOT, config.testDir ?? '.')).toBe(path.join(ROOT, 'e2e'));
  });

  it.each([
    ['phone', 390, 844],
    ['desktop', 1280, 800],
  ])('has exactly one %s project at %i×%i', (_label, width, height) => {
    const matching = (config.projects ?? []).filter((project) => {
      const viewport = effectiveUse(config, project).viewport;
      return viewport?.width === width && viewport?.height === height;
    });
    expect(matching).toHaveLength(1);
  });

  it('runs every project in Playwright’s Chromium only', () => {
    const projects = config.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      const use = effectiveUse(config, project);
      expect(use.browserName ?? 'chromium').toBe('chromium');
      // A channel such as "chrome" would need a branded browser CI does not install.
      expect(use.channel ?? 'chromium').toMatch(/^chromium/);
    }
  });

  it('uses the German locale de-DE in every project', () => {
    const projects = config.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      expect(effectiveUse(config, project).locale).toBe('de-DE');
    }
  });

  it('keeps traces and screenshots of failed tests', () => {
    for (const project of config.projects ?? []) {
      const use = effectiveUse(config, project);
      expect(mode(use.trace) ?? 'off').not.toBe('off');
      expect(mode(use.screenshot) ?? 'off').not.toBe('off');
    }
  });

  it('builds the static web export and serves it through webServer, at the base URL', () => {
    const servers = [config.webServer ?? []].flat();
    const server = servers.find((s) => /\bexpo export\b/.test(s.command ?? ''));
    expect(server).toBeDefined();

    const command = server?.command ?? '';
    expect(command).toMatch(/\bexpo export\b[^;&|]*(?:-p|--platform)[ =]web\b/);
    // Something serves the export after it is built; SPA fallback is checked in
    // e2e/app.spec.ts, so the server is not pinned here.
    expect(command.slice(command.search(/\bexpo export\b/))).toMatch(/&&.*\bserve\b/);
    expect(server?.url ?? server?.port).toBeDefined();
    expect(config.use?.baseURL).toEqual(expect.any(String));
  });
});
