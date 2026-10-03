/**
 * @jest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const AGENT = path.join(process.cwd(), '.claude', 'agents', 'ui-verifier.md');

// The agent file split into its YAML frontmatter (flat `key: value` lines)
// and the Markdown body after it.
function agent(): { meta: Record<string, string>; body: string } {
  if (!existsSync(AGENT)) throw new Error('.claude/agents/ui-verifier.md does not exist');
  const text = readFileSync(AGENT, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('ui-verifier.md has no frontmatter');
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const pair = /^(\w+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].trim();
  }
  return { meta, body: match[2] };
}

// The `tools` frontmatter entry as a list of tool names.
function tools(): string[] {
  return (agent().meta.tools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
}

// Playwright MCP tools that run arbitrary code, touch files, storage or the
// network, or record, and so don't fit a read-only verifier.
const UNSAFE_BROWSER_TOOLS = [
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_pdf_save',
  'browser_storage_state',
  'browser_set_storage_state',
  'browser_route',
  'browser_start_tracing',
  'browser_start_video',
  'browser_start_recording',
];

// The allowlist: the read-only built-ins and the named, safe Playwright
// browser tools. Wildcards, whole servers and anything unknown fail.
function isAllowedTool(tool: string): boolean {
  if (['Read', 'Grep', 'Glob'].includes(tool)) return true;
  const match = /^mcp__playwright__(browser_[a-z_]+)$/.exec(tool);
  return match !== null && !UNSAFE_BROWSER_TOOLS.includes(match[1]);
}

describe('the ui-verifier agent', () => {
  it('declares its name, a description and a tools list in the frontmatter', () => {
    const { meta } = agent();

    expect(meta.name).toBe('ui-verifier');
    expect(meta.description?.length).toBeGreaterThan(0);
    expect(tools().length).toBeGreaterThan(0);
  });

  it.each([
    'mcp__playwright__browser_navigate',
    'mcp__playwright__browser_resize',
    'mcp__playwright__browser_take_screenshot',
    'mcp__playwright__browser_snapshot',
  ])('may use the Playwright MCP tool %s', (tool) => {
    expect(tools()).toContain(tool);
  });

  it('has only read-only tools: Read, Grep, Glob and the safe Playwright browser tools', () => {
    const list = tools();

    // An empty list would let the check pass vacuously.
    expect(list.length).toBeGreaterThan(0);
    // Listing the tools that fail names each one in the failure message.
    expect(list.filter((tool) => !isAllowedTool(tool))).toEqual([]);
  });

  it('checks the app at the phone and desktop widths of playwright.config.ts', () => {
    const { body } = agent();

    expect(body).toMatch(/\b390\b/);
    expect(body).toMatch(/\b1280\b/);
  });

  it('gives its screenshots filenames that start with .claude/state/', () => {
    // Playwright MCP resolves an explicit filename against the workspace
    // root, not --output-dir, so the body must say where the files go.
    const lines = agent().body.split('\n');

    expect(lines.some((line) => /filename/i.test(line) && line.includes('.claude/state/'))).toBe(
      true,
    );
  });

  it('checks the empty, loading and error states and text overflow, and reports', () => {
    const { body } = agent();

    expect(body).toMatch(/\bempty\b/i);
    expect(body).toMatch(/\bloading\b/i);
    expect(body).toMatch(/\berror\b/i);
    expect(body).toMatch(/overflow/i);
    expect(body).toMatch(/\breport/i);
  });
});
