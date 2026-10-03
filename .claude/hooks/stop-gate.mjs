// Stop / SubagentStop: the agent may not end its turn while approved tests
// fail or production code has type errors. New tests, and committed tests the
// agent changed while the human had them unlocked (recorded by
// protect-tests.mjs), may be red: that is gate 1, where they wait for
// approval. A branch that changes only docs or GitHub config skips the checks,
// since it can't turn them red. After QUIZ_STOP_CAP blocked stops in one turn the agent must write
// an escalation note instead of trying again; a few stops later it is released
// regardless, so it never loops.
import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_DIR,
  bin,
  block,
  ensureStateDir,
  hasUncommittedChanges,
  isCommitted,
  isTestFile,
  parseTscErrors,
  projectDir,
  readInput,
  readUnlockedEdits,
  relativeToProject,
  respond,
  run,
  tscArgs,
  writeUnlockedEdits,
} from './lib.mjs';

// Agents that leave red tests behind by design: the test-writer at gate 1,
// and the read-only reviewer, which changes nothing.
const MAY_STOP_RED = new Set(['test-writer', 'reviewer']);
const CAP = Number(process.env.QUIZ_STOP_CAP ?? 10);
// Stops past the cap without a note before the agent is released anyway.
const GRACE = 3;
const ESCALATION_NOTE = `${STATE_DIR}/escalation.md`;
// Changes that can't affect Jest or tsc. An allowlist, so that an unforeseen
// file type runs the checks rather than skips them.
const NO_CHECKS_NEEDED = [/\.md$/, /^docs\//, /^\.github\//];

const input = await readInput();
const dir = projectDir(input);
// A recorded re-spec ends once the file matches HEAD again (approved or reverted).
const unlockedEdits = readUnlockedEdits(dir).filter((rel) => hasUncommittedChanges(dir, rel));
writeUnlockedEdits(dir, unlockedEdits);

if (!MAY_STOP_RED.has(input.agent_type)) {
  ensureStateDir(dir);
  const stateFile = path.join(
    dir,
    STATE_DIR,
    `stop-gate-${input.session_id ?? 'unknown'}-${input.agent_id ?? 'main'}.json`,
  );
  // stop_hook_active is false on the first stop of a turn: a new turn, a new count.
  const state = input.stop_hook_active ? readState(stateFile) : { blocks: 0 };

  const failures = await findFailures();
  if (failures.length === 0) {
    fs.rmSync(stateFile, { force: true });
  } else {
    state.blocks += 1;
    if (state.blocks <= CAP) {
      writeState(stateFile, state);
      block(
        `Not done: approved tests or the typecheck are red (blocked stop ${state.blocks} of ${CAP}). ` +
          `Fix the code, not the tests.\n\n${failures.join('\n\n')}`,
      );
    } else {
      state.capReachedAt ??= Date.now();
      if (noteWrittenSince(state.capReachedAt) || state.blocks > CAP + GRACE) {
        fs.rmSync(stateFile, { force: true });
        respond({
          systemMessage: `Stop gate released after ${CAP} blocked stops; tests are still red. See ${ESCALATION_NOTE}.`,
        });
      } else {
        writeState(stateFile, state);
        block(
          `Cap of ${CAP} attempts reached. Stop trying fixes. Write ${ESCALATION_NOTE}: ` +
            `what you tried, what you observed and where you are stuck. Then stop and ` +
            `summarise it for the human.\n\n${failures.join('\n\n')}`,
        );
      }
    }
  }
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { blocks: 0 };
  }
}

function writeState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state));
}

function noteWrittenSince(time) {
  try {
    return fs.statSync(path.join(dir, ESCALATION_NOTE)).mtimeMs >= time;
  } catch {
    return false;
  }
}

/**
 * A failure counts unless it lives only in a test that awaits approval: a new
 * test, or a committed one with a recorded unlocked edit (a re-spec).
 */
function blocking(rel) {
  return !rel || !isTestFile(rel) || (isCommitted(dir, rel) && !unlockedEdits.includes(rel));
}

async function findFailures() {
  const base = await changeBase();
  if (base && (await changedFiles(base)).every(noChecksNeeded)) return [];
  const [tests, types] = await Promise.all([runTests(base), runTypecheck()]);
  return [...tests, ...types];
}

async function changeBase() {
  const base = await run('git', ['merge-base', 'HEAD', 'origin/main'], dir);
  return base.code === 0 ? base.output.trim() : undefined;
}

/** Files changed since the base: committed, uncommitted and untracked ones. */
async function changedFiles(base) {
  const [tracked, untracked] = await Promise.all([
    run('git', ['diff', '--name-only', '--no-renames', '-z', base], dir),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], dir),
  ]);
  // A failed git call can't prove the change harmless: count it as code.
  if (tracked.code !== 0 || untracked.code !== 0) return [undefined];
  return `${tracked.output}${untracked.output}`.split('\0').filter(Boolean);
}

function noChecksNeeded(rel) {
  return rel !== undefined && NO_CHECKS_NEEDED.some((pattern) => pattern.test(rel));
}

async function runTests(base) {
  const report = path.join(dir, STATE_DIR, 'jest-report.json');
  fs.rmSync(report, { force: true });
  const result = await run(
    bin(dir, 'jest'),
    [
      base ? `--changedSince=${base}` : '--onlyChanged',
      '--json',
      `--outputFile=${report}`,
      '--silent',
      '--passWithNoTests',
    ],
    dir,
  );
  if (result.code === 0) return [];
  if (result.setup) return [result.output];
  if (!fs.existsSync(report)) return [`Jest did not run:\n${result.output.trim()}`];

  const { testResults } = JSON.parse(fs.readFileSync(report, 'utf8'));
  return testResults
    .filter((suite) => suite.status === 'failed')
    .map((suite) => ({ rel: relativeToProject(dir, suite.name), message: suite.message }))
    .filter(({ rel }) => blocking(rel))
    .map(({ rel, message }) => `Failing test ${rel}:\n${message.trim()}`);
}

async function runTypecheck() {
  if (!fs.existsSync(path.join(dir, 'tsconfig.json'))) return [];
  const result = await run(bin(dir, 'tsc'), tscArgs(dir), dir);
  // TS18003 means there are no TypeScript files yet: nothing to check.
  if (result.code === 0 || result.output.includes('error TS18003')) return [];
  if (result.setup) return [result.output];
  const errors = parseTscErrors(result.output);
  if (errors.length === 0) return [`TypeScript failed:\n${result.output.trim()}`];
  const blockingErrors = errors.filter(({ file }) =>
    blocking(file && relativeToProject(dir, file)),
  );
  return blockingErrors.length === 0
    ? []
    : [`TypeScript:\n${blockingErrors.map(({ line }) => line).join('\n')}`];
}
