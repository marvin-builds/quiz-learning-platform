/**
 * @jest-environment node
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MCP_JSON = path.join(ROOT, '.mcp.json');
const STATE_DIR = path.join(ROOT, '.claude', 'state');

type Server = { command?: string; args?: string[] };

// The `playwright` entry of the project's .mcp.json.
function playwrightServer(): Server {
  if (!existsSync(MCP_JSON)) throw new Error('.mcp.json does not exist');
  const config = JSON.parse(readFileSync(MCP_JSON, 'utf8')) as {
    mcpServers?: Record<string, Server>;
  };
  const server = config.mcpServers?.playwright;
  if (!server) throw new Error('.mcp.json has no mcpServers.playwright entry');
  return server;
}

function args(): string[] {
  return playwrightServer().args ?? [];
}

// The value of a flag, given as `--flag value` or `--flag=value`.
function flagValue(flag: string): string | undefined {
  const list = args();
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === flag) return list[i + 1];
    if (list[i].startsWith(`${flag}=`)) return list[i].slice(flag.length + 1);
  }
  return undefined;
}

describe('the Playwright MCP server in .mcp.json', () => {
  it('runs @playwright/mcp through npx at an exact pinned version', () => {
    const server = playwrightServer();
    const pkg = args().find((arg) => arg.startsWith('@playwright/mcp'));

    expect(server.command).toBe('npx');
    expect(pkg).toMatch(/^@playwright\/mcp@\d+\.\d+\.\d+$/);
  });

  it('allows only http origins on localhost or 127.0.0.1', () => {
    const value = flagValue('--allowed-origins');
    const origins = (value ?? '')
      .split(';')
      .map((origin) => origin.trim())
      .filter(Boolean);

    // An empty list would let the loop below pass vacuously.
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) {
      expect(origin).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)(:(\d+|\*))?\/?$/);
    }
  });

  it('runs the browser headless', () => {
    expect(args()).toContain('--headless');
  });

  it('writes its screenshots and other output inside .claude/state/', () => {
    const value = flagValue('--output-dir');

    expect(value).toBeDefined();
    const resolved = path.resolve(ROOT, value as string);
    expect(path.relative(STATE_DIR, resolved)).not.toMatch(/^\.\.(\/|$)|^\//);
  });

  it('keeps .claude/state/ out of git', () => {
    // Exit status 0 means the path is ignored; anything else throws.
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', '.claude/state/screenshot.png'], { cwd: ROOT }),
    ).not.toThrow();
  });
});
