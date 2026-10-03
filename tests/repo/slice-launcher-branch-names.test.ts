/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const SCRIPT = path.join(process.cwd(), 'scripts', 'slice.mjs');

// A repo with a bare origin and a fake `gh` that lists one open issue, enough
// for `--pick` to print the branch name it would create.
function pickBranch(title: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-names-')));
  try {
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    };
    const app = path.join(root, 'app');
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(root, 'clone', '-q', path.join(root, 'origin.git'), app);
    git(
      app,
      '-c',
      'user.email=f@example.com',
      '-c',
      'user.name=F',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'Initial',
    );
    git(app, 'push', '-q', 'origin', 'HEAD:main');
    const issues = [{ number: 8, title, milestone: null, body: '', state: 'OPEN' }];
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(
      path.join(root, 'bin', 'gh'),
      `#!/bin/sh\necho '${JSON.stringify(issues).replace(/'/g, "'\\''")}'\n`,
      { mode: 0o755 },
    );
    const result = spawnSync('node', [SCRIPT, '--pick'], {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout).branch;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('slice launcher branch names', () => {
  it('drops filler words left at the end by the four-word cut', () => {
    expect(pickBranch('1.8 Images in questions and answers')).toBe('8-images-in-questions');
  });

  it('keeps filler words inside the name', () => {
    expect(pickBranch('Upgrade to Expo SDK 58 when it is stable')).toBe('8-upgrade-to-expo-sdk');
  });
});
