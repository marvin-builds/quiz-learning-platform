/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CLAUDE_MD = path.join(process.cwd(), 'CLAUDE.md');

// The bullets of the `## Commands` section, continuation lines included.
function commandBullets(): string[] {
  const text = readFileSync(CLAUDE_MD, 'utf8');
  const match = /^## Commands\s*$([\s\S]*?)(?=^## )/m.exec(text);
  if (!match) throw new Error('CLAUDE.md has no Commands section');
  return match[1]
    .split(/\n(?=- )/)
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet.startsWith('- '));
}

function bullet(command: string): string {
  const found = commandBullets().find((b) => b.startsWith(`- \`${command}`));
  if (!found) throw new Error(`CLAUDE.md Commands lists no \`${command}\``);
  return found;
}

describe('CLAUDE.md documents the e2e tests', () => {
  it('lists npm run test:e2e with its preconditions: the local stack running and reset', () => {
    const e2e = bullet('npm run test:e2e');

    expect(e2e).toMatch(/supabase start/);
    expect(e2e).toMatch(/db reset/);
  });

  it('says that npm run -s check does not run the e2e tests', () => {
    const e2e = bullet('npm run test:e2e');
    const check = bullet('npm run -s check');

    expect(/\bcheck\b/.test(e2e) || /\be2e\b/i.test(check)).toBe(true);
  });
});
