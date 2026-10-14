/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Issue #126: the docs follow CI in running eas from the lockfile, and the
// plan records the supply-chain decision.

const ROOT = process.cwd();

function read(...parts: string[]): string {
  return readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function section(text: string, heading: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`no heading matching ${heading}`);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('docs/mobile-smoke-test.md', () => {
  it('runs eas from the lockfile, never through npx -y or a pinned eas-cli@version', () => {
    const doc = read('docs', 'mobile-smoke-test.md');

    expect(doc).not.toMatch(/\bnpx\s+(?:-y|--yes)\b/);
    expect(doc).not.toMatch(/\beas-cli@/);
    expect(doc).toMatch(/\bnpx\s+(?:--no-install\s+)?eas\s+login\b/);
  });

  it('points the local dev build at the locked build plugin instead of a runtime npx download', () => {
    const doc = read('docs', 'mobile-smoke-test.md');

    expect(doc).toMatch(/\beas\s+build\s+--local\b/);
    expect(doc).toMatch(
      /EAS_LOCAL_BUILD_PLUGIN_PATH=\S*node_modules\/(?:\.bin\/eas-cli-local-build-plugin|eas-cli-local-build-plugin\/bin\/run)\b/,
    );
  });
});

// `wrangler 4.147.0`, `` `wrangler` 4.147.0 `` or `wrangler@4.147.0`.
function versionMention(name: string, version: string): RegExp {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\`?\\b${escape(name)}\`?[ @]\`?${escape(version)}(?![\\w.])`);
}

describe('the plan decisions (section 7)', () => {
  const decisions = (): string =>
    section(read('docs', 'plan', 'mvp-implementation-plan.md'), /^## 7\. Decisions/);

  it('says CI tools run from the lockfile through npx --no-install, with exact pins', () => {
    const devDependencies: Record<string, string> =
      JSON.parse(read('package.json')).devDependencies ?? {};
    const wrangler = devDependencies['wrangler'];
    const easCli = devDependencies['eas-cli'];

    expect(decisions()).toMatch(/npx --no-install/);
    expect(wrangler).toMatch(/^\d+\.\d+\.\d+$/);
    expect(easCli).toMatch(/^\d+\.\d+\.\d+$/);
    expect(decisions()).toMatch(versionMention('wrangler', wrangler));
    expect(decisions()).toMatch(versionMention('eas-cli', easCli));
  });

  it('says actions are pinned by commit SHA with tag comments that Dependabot updates', () => {
    expect(decisions()).toMatch(/^\|.*\bSHA\b.*\bDependabot\b|^\|.*\bDependabot\b.*\bSHA\b/m);
  });

  it('describes how the local build plugin of eas build --local is kept in the lockfile', () => {
    expect(decisions()).toMatch(/eas-cli-local-build-plugin/);
    expect(decisions()).toMatch(/EAS_LOCAL_BUILD_PLUGIN_PATH/);
    expect(decisions()).toMatch(
      /\b(?:bump|bumped|update|updated|upgrade|upgraded)\b[^\n]*\btogether\b|\btogether with eas-cli\b/i,
    );
  });
});
