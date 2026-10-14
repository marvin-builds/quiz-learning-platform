/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Issue #126: CI runs its tools from package-lock.json only, and every action
// is pinned by a full commit SHA.

const ROOT = process.cwd();
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type LockEntry = { version?: string; bin?: Record<string, string> | string };
type Lockfile = { packages: Record<string, LockEntry> };

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, name), 'utf8')) as T;
}

const pkg = readJson<PackageJson>('package.json');
const lock = readJson<Lockfile>('package-lock.json');

const workflowFiles = readdirSync(WORKFLOWS)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

function read(name: string): string {
  return readFileSync(path.join(WORKFLOWS, name), 'utf8');
}

// Text without comment lines, with shell line continuations joined, so one
// command is on one line.
function commandText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\r?\n\s*/g, ' ');
}

function commands(name: string): string {
  return commandText(read(name));
}

type ExecCall = { text: string; flags: string[]; command: string | undefined };

// Flags of npx / npm exec that take the next token as their value.
const FLAGS_WITH_VALUE = new Set(['-p', '--package', '-c', '--call', '--workspace', '-w']);

// Every `npx …`, `npm exec …` or `npm x …` call in the text, also inside a
// quoted shell variable such as `wrangler="npx --no-install wrangler"`. Only
// the flags in front of the command are the runner's; `eas build -p android`
// passes `-p` to eas, not to npx.
function execCallsIn(text: string): ExecCall[] {
  const pattern = /(?:^|[\s"'`(;|&])((?:npx|npm\s+(?:exec|x))\s+[^\n"'`;|&)]*)/g;
  return [...commandText(text).matchAll(pattern)].map((match) => {
    const tokens = match[1].trim().split(/\s+/);
    const rest = tokens.slice(tokens[0] === 'npx' ? 1 : 2);
    const flags: string[] = [];
    let index = 0;
    while (index < rest.length && rest[index].startsWith('-')) {
      const flag = rest[index];
      index += 1;
      if (flag === '--') break;
      flags.push(flag);
      if (FLAGS_WITH_VALUE.has(flag) && index < rest.length) index += 1;
    }
    return { text: match[1].trim(), flags, command: rest[index] };
  });
}

function execCalls(name: string): ExecCall[] {
  return execCallsIn(read(name));
}

function allCalls(): ExecCall[] {
  return workflowFiles.flatMap(execCalls);
}

// Bins that packages declared in package.json provide, as the lockfile resolves them.
function lockedBins(): Map<string, string> {
  const bins = new Map<string, string>();
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const name of declared) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry?.bin) continue;
    const names =
      typeof entry.bin === 'string' ? [name.replace(/^@[^/]+\//, '')] : Object.keys(entry.bin);
    for (const bin of names) bins.set(bin, name);
  }
  return bins;
}

function lockedVersion(name: string): string | undefined {
  return lock.packages[`node_modules/${name}`]?.version;
}

// Steps of a workflow, each starting at its `- ` line under `steps:`.
function steps(name: string): string[] {
  return read(name)
    .split(/\n(?= {6}- )/)
    .slice(1);
}

// The step that runs `eas build`, however eas is called (the same reading as
// android-build-workflow.test.ts).
function easBuildStep(): string {
  const matching = workflowFiles
    .flatMap(steps)
    .filter((step) => /^(?!\s*#).*(?:\beas|eas-cli@\S+|\$\{?eas\}?)\s+build\b/m.test(step));
  expect(matching).toHaveLength(1);
  return matching[0];
}

const DOWNLOAD_FLAG = /^(?:-y|--yes(?:=true)?|-p|--package(?:=.*)?|-c|--call(?:=.*)?)$/;

describe('CI tools come from the lockfile (no workflow runs npx -y or installs a tool outside it)', () => {
  it('scans every workflow file, so the checks below cannot pass vacuously', () => {
    expect(workflowFiles).toEqual(expect.arrayContaining(['ci.yml', 'android-preview.yml']));
    expect(allCalls().length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)(
    '%s calls npx and npm exec without -y, --yes, -p, --package or a name@version',
    (name) => {
      const offending = execCalls(name)
        .filter(
          (call) =>
            call.flags.some((flag) => DOWNLOAD_FLAG.test(flag)) ||
            /^(?:@[^/\s]+\/)?[^@\s]+@/.test(call.command ?? ''),
        )
        .map((call) => call.text);

      expect(offending).toEqual([]);
    },
  );

  it.each(workflowFiles)(
    '%s installs no tool outside the lockfile (npm install, -g, dlx, curl | sh)',
    (name) => {
      const text = commands(name);
      const offending = [
        ...text.matchAll(/^.*\bnpm\s+(?:install|i|add|isntall|in|ins)\b.*$/gm),
        ...text.matchAll(/^.*\b(?:npm|npx|yarn|pnpm)\b.*\s(?:-g|--global)\b.*$/gm),
        ...text.matchAll(/^.*\b(?:pnpm|yarn)\s+dlx\b.*$/gm),
        ...text.matchAll(/^.*\bbunx\b.*$/gm),
        ...text.matchAll(/^.*\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b.*$/gm),
      ].map((match) => match[0].trim());

      expect(offending).toEqual([]);
    },
  );

  it.each(workflowFiles)(
    '%s runs through npx and npm exec only bins of packages in package.json that the lockfile resolves',
    (name) => {
      const bins = lockedBins();
      const undeclared = execCalls(name)
        .filter((call) => call.command === undefined || !bins.has(call.command))
        .map((call) => call.text);

      expect(undeclared).toEqual([]);
    },
  );

  it('calls wrangler and eas through npx --no-install (or npm exec --no)', () => {
    const tools = allCalls().filter(
      (call) => call.command === 'wrangler' || call.command === 'eas',
    );

    expect(tools.map((call) => call.command)).toEqual(expect.arrayContaining(['wrangler', 'eas']));
    for (const call of tools) {
      expect({
        call: call.text,
        offline: call.flags.some((f) => f === '--no-install' || f === '--no'),
      }).toEqual({
        call: call.text,
        offline: true,
      });
    }
  });

  it.each([
    ['wrangler', '4.147.0'],
    ['eas-cli', '24.10.0'],
  ])('pins %s exactly to %s as a dev dependency that the lockfile resolves', (name, version) => {
    expect(pkg.devDependencies?.[name]).toBe(version);
    expect(pkg.dependencies ?? {}).not.toHaveProperty([name]);
    expect(lockedVersion(name)).toBe(version);
  });

  it('pins eas-cli-local-build-plugin exactly to the version the locked eas-cli asks for', () => {
    // eas-cli runs `npx -y eas-cli-local-build-plugin@<version of its
    // @expo/eas-build-job>` unless EAS_LOCAL_BUILD_PLUGIN_PATH is set.
    expect(lockedVersion('eas-cli')).toBeDefined();
    const buildJob =
      lock.packages['node_modules/eas-cli/node_modules/@expo/eas-build-job'] ??
      lock.packages['node_modules/@expo/eas-build-job'];
    const expected = buildJob?.version;

    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies?.['eas-cli-local-build-plugin']).toBe(expected);
    expect(lockedVersion('eas-cli-local-build-plugin')).toBe(expected);
  });

  it('points EAS_LOCAL_BUILD_PLUGIN_PATH of the eas build step at the locally installed plugin', () => {
    // eas-cli spawns the value without a shell, and Actions does not
    // shell-expand env: values, so under env: only ${{ github.workspace }}/ or
    // ./ work; $GITHUB_WORKSPACE and $PWD only in an inline shell assignment.
    const step = easBuildStep();
    const plugin = String.raw`node_modules\/(?:\.bin\/eas-cli-local-build-plugin|eas-cli-local-build-plugin\/bin\/run)`;
    const envValue = /^\s*EAS_LOCAL_BUILD_PLUGIN_PATH:[ \t]*(.*?)[ \t]*(?:#.*)?$/m
      .exec(step)?.[1]
      ?.replace(/^(["'])(.*)\1$/, '$2');
    const inlineValue = /\bEAS_LOCAL_BUILD_PLUGIN_PATH=(["']?)([^"'\s;]+)\1/.exec(step)?.[2];

    const envOk =
      envValue !== undefined &&
      new RegExp(String.raw`^(?:\$\{\{\s*github\.workspace\s*\}\}\/|\.\/)?${plugin}$`).test(
        envValue,
      );
    const inlineOk =
      inlineValue !== undefined &&
      new RegExp(String.raw`^(?:\$\{?GITHUB_WORKSPACE\}?\/|\$\{?PWD\}?\/|\.\/)?${plugin}$`).test(
        inlineValue,
      );

    expect({ envValue, inlineValue, ok: envOk || inlineOk }).toEqual({
      envValue,
      inlineValue,
      ok: true,
    });
  });
});

// `uses: <ref> # <comment>`, as a list item or a key of a named step, quoted or not.
function usesLines(name: string): { ref: string; comment: string; line: string }[] {
  return read(name)
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:-\s+)?uses:/.test(line))
    .map((line) => {
      const match = /^\s*(?:-\s+)?uses:\s*(["']?)([^"'\s#]*)\1\s*(#.*)?$/.exec(line);
      return { ref: match?.[2] ?? '', comment: (match?.[3] ?? '').trim(), line: line.trim() };
    });
}

const ACTION_BY_SHA = /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_BY_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

describe('every uses: names a full commit SHA', () => {
  it.each(workflowFiles)(
    '%s uses at least one action, so the check cannot pass vacuously',
    (name) => {
      expect(usesLines(name).length).toBeGreaterThan(0);
    },
  );

  it.each(workflowFiles)(
    '%s pins every action by a 40-character commit SHA with a # v<tag> comment',
    (name) => {
      const offending = usesLines(name)
        .filter(
          ({ ref, comment }) =>
            !DOCKER_BY_DIGEST.test(ref) &&
            !(ACTION_BY_SHA.test(ref) && /^#\s*v\d+(?:\.\d+)*(?:[-+][\w.-]+)?$/.test(comment)),
        )
        .map(({ line }) => line);

      expect(offending).toEqual([]);
    },
  );

  it('pins each action tag to the same SHA in every workflow', () => {
    const shas = new Map<string, Set<string>>();
    for (const name of workflowFiles) {
      for (const { ref, comment } of usesLines(name)) {
        const [action, sha] = ref.split('@');
        const key = `${action} ${comment}`;
        shas.set(key, (shas.get(key) ?? new Set()).add(sha));
      }
    }
    const conflicting = [...shas].filter(([, set]) => set.size > 1).map(([key]) => key);

    expect(conflicting).toEqual([]);
  });
});
