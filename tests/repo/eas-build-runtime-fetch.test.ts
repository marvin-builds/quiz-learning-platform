/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Issue #126, review follow-up: `eas build --local` must not fetch tools from
// npm at run time. The build plugin's setup phase runs `npx -y expo-doctor`
// (with the build's env, so with EXPO_TOKEN) unless
// EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP is set, and expo-doctor isn't in the
// lockfile. The docs log in to eas from the lockfile only, without npx's
// download fallback.

const ROOT = process.cwd();

function read(...parts: string[]): string {
  return readFileSync(path.join(ROOT, ...parts), 'utf8');
}

// The steps of a workflow, each as the text from its `- ` line to the next.
function steps(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const starts = lines
    .map((line, index) => (/^\s{6}-\s/.test(line) ? index : -1))
    .filter((index) => index !== -1);
  return starts.map((start, i) => lines.slice(start, starts[i + 1]).join('\n'));
}

describe('eas build --local fetches nothing from npm at run time', () => {
  it('disables the build plugin’s npx -y expo-doctor step in the android workflow', () => {
    const buildSteps = steps(read('.github', 'workflows', 'android-preview.yml')).filter((step) =>
      /^(?!\s*#).*\beas\s+build\b/m.test(step),
    );

    expect(buildSteps).toHaveLength(1);
    expect(buildSteps[0]).toMatch(
      /^\s*EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP:\s*(["']?)(?:1|true)\1\s*(?:#.*)?$/m,
    );
  });

  it('disables it in the local dev build of the smoke-test doc too', () => {
    const doc = read('docs', 'mobile-smoke-test.md');

    expect(doc).toMatch(/\beas\s+build\s+--local\b/);
    expect(doc).toMatch(/\bEAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=(["']?)(?:1|true)\1(?:\s|$)/);
  });

  it('logs in to eas in the smoke-test doc without npx’s download fallback', () => {
    const doc = read('docs', 'mobile-smoke-test.md');

    expect(doc).toMatch(/\b(?:npx\s+--no-install|npm\s+exec\s+--no\s+--)\s+eas\s+login\b/);
    expect(doc).not.toMatch(/\bnpx\s+eas\s+login\b/);
  });
});
