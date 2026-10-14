/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RULE = 'no-restricted-imports';

// ESLint 9 loads its config with a dynamic import, which Jest's module VM does
// not support, so the project's real ESLint CLI runs in a child process.
function lint(source: string, filename: string): string[] {
  const eslintBin = path.join(process.cwd(), 'node_modules', '.bin', 'eslint');
  const { stdout, stderr } = spawnSync(
    eslintBin,
    ['--stdin', '--stdin-filename', filename, '--format', 'json'],
    { input: source, encoding: 'utf8' },
  );
  if (!stdout) {
    throw new Error(`ESLint produced no output: ${stderr}`);
  }
  const [result] = JSON.parse(stdout) as {
    messages: { ruleId: string | null; message: string }[];
  }[];
  return result.messages.map((message) => message.ruleId ?? message.message);
}

const SOURCE = `import { z } from 'zod';

export const schema = z.string();
`;

describe('zod only through src/lib/zod.ts (jitless under the CSP)', () => {
  it('rejects a direct zod import in app code', () => {
    expect(lint(SOURCE, 'src/lib/example-schema.ts')).toContain(RULE);
  });

  it('rejects a zod subpath import in app code', () => {
    const source = `import { z } from 'zod/v4';

export const schema = z.string();
`;
    expect(lint(source, 'src/components/example.tsx')).toContain(RULE);
  });

  it('allows the zod import in src/lib/zod.ts itself', () => {
    expect(lint(SOURCE, 'src/lib/zod.ts')).not.toContain(RULE);
  });

  it('allows the zod form resolver', () => {
    const source = `import { zodResolver } from '@hookform/resolvers/zod';

export const resolver = zodResolver;
`;
    expect(lint(source, 'src/components/example.tsx')).not.toContain(RULE);
  });
});
