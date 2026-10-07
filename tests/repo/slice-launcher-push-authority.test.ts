/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(60_000);

const SCRIPT = path.join(process.cwd(), 'scripts', 'slice.mjs');

// The session the launcher starts gets push authority for its own branch:
// the personal push guard reads AI_PUSH_AUTHORITY from Claude Code's
// environment, which a command inside the session can't set.
describe('slice launcher push authority', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slice-push-')));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function startSession(launcherEnv: Record<string, string | undefined>) {
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
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'claude-env.json');
    const issue = { number: 8, title: 'Admin guard', milestone: null, body: '', state: 'OPEN' };
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '${JSON.stringify(issue)}'\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ marker: process.env.AI_PUSH_AUTHORITY ?? null }));\n`,
      { mode: 0o755 },
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    };
    delete env.AI_PUSH_AUTHORITY;
    const result = spawnSync('node', [SCRIPT, '8'], {
      cwd: app,
      encoding: 'utf8',
      env: { ...env, ...launcherEnv },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(fs.readFileSync(log, 'utf8')).marker;
  }

  it('starts the semi-auto session with AI_PUSH_AUTHORITY=1', () => {
    expect(startSession({})).toBe('1');
  });

  it('sets the marker itself rather than relying on the terminal it runs in', () => {
    expect(startSession({ AI_PUSH_AUTHORITY: '0' })).toBe('1');
  });
});
