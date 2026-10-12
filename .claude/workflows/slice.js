export const meta = {
  name: 'slice',
  description:
    'One issue through the semi-auto loop in its own worktree: spec review, failing tests and their review, green, verify, review, commits; never pushes',
  whenToUse:
    'Started by the orchestrator skill, one run per slice; args {issue, worktree, branch, base, phase, ports}',
  phases: [
    { title: 'Spec', detail: 'reviewer checks the issue against the plan, ADRs and code' },
    { title: 'Red', detail: 'test-writer, test run, test review, one fix pass, commit' },
    { title: 'Green', detail: 'implement, refactor' },
    { title: 'Verify', detail: 'check, pgTAP, e2e under the lock, ui-verifier' },
    { title: 'Review', detail: 'reviewer and fixes, at most 3 rounds' },
  ],
};

// args:
//   issue     issue number
//   worktree  absolute path of the slice's worktree (from `slice.mjs --no-session`)
//   branch    its branch
//   base      what the branch is compared with: 'origin/main', or the parent
//             branch of a stacked child
//   phase     'all' (red, then green unless the slice is database security),
//             'red' (up to uncommitted, reviewed failing tests) or 'green'
//             (after the human approved the tests at gate 1)
//   ports     { web } for the ui-verifier's dev server, from .env.local
//   notes     the orchestrator's readings or answers to pass on (optional)
//   ui        whether the slice changes screens; the red run finds out, so
//             the orchestrator passes the red report's `ui` to a green run
const {
  issue,
  worktree: WT,
  branch,
  base = 'origin/main',
  phase: run = 'all',
  ports = {},
  notes = '',
  ui,
} = args;
if (!issue || !WT || !branch)
  throw new Error('slice workflow needs args.issue, args.worktree and args.branch');

// The first line of every prompt: the stop gate reads it on SubagentStop and
// checks this worktree, not the orchestrator's checkout (.claude/hooks/lib.mjs).
const HEAD = `Slice worktree: ${WT}

You work on issue #${issue}, branch ${branch}, in the worktree above. Your cwd is the orchestrator's checkout and \`cd\` doesn't persist between Bash calls: use absolute paths for files, \`git -C ${WT} …\` for git, and \`cd ${WT} && …\` within one command for npm/npx. Never touch another checkout. The branch is compared with ${base} (\`git -C ${WT} diff ${base}...HEAD\`). Judgment calls the issue, docs and tests don't settle go into ${WT}/.claude/state/decisions.md (decision, where it lands, options, confidence high/medium/low, reversal cost) as you make them; if you can't write files there (test-writer, reviewer), put them in your result instead and a later step logs them.${notes ? `\n\nNotes from the orchestrator:\n${notes}` : ''}`;

const STATUS = { type: 'string', enum: ['ok', 'needs-human', 'stuck'] };
const FINDINGS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      finding: { type: 'string' },
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      triage: {
        type: 'string',
        description: 'accepted / rejected: reason / deferred: reason; empty from a reviewer',
      },
    },
    required: ['finding', 'severity'],
  },
};
const SPEC = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['pass', 'readings', 'conflict'] },
    conflicts: {
      type: 'array',
      items: { type: 'string' },
      description: 'conflicts with the goal, plan, an ADR or a never-break rule',
    },
    readings: {
      type: 'array',
      items: { type: 'string' },
      description: 'ambiguities and gaps, each with the most conservative reading',
    },
    dbSecurity: {
      type: 'boolean',
      description:
        'the slice adds or changes an RLS policy, a grant, a security definer function or a Storage policy',
    },
    ui: { type: 'boolean', description: 'the slice changes screens' },
  },
  required: ['result', 'conflicts', 'readings', 'dbSecurity', 'ui'],
};
const TESTS = {
  type: 'object',
  properties: {
    status: STATUS,
    gate1: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, behaviors: { type: 'string' } },
        required: ['file', 'behaviors'],
      },
    },
    failsForRightReason: { type: 'boolean' },
    wrongReasons: { type: 'array', items: { type: 'string' } },
    designChoices: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'gate1', 'failsForRightReason', 'designChoices'],
};
const REVIEW = {
  type: 'object',
  properties: { blockers: { type: 'boolean' }, findings: FINDINGS },
  required: ['blockers', 'findings'],
};
const report = { issue, branch, worktree: WT, base, phase: run, stages: {} };
const stop = (status, stage, detail) => ({ ...report, status, stoppedAt: stage, detail });

async function step(name, prompt, opts) {
  const result = await agent(`${HEAD}\n\n${prompt}`, { label: `${name}:#${issue}`, ...opts });
  if (!result) throw new Error(`${name} returned nothing`);
  report.stages[name] = result;
  return result;
}

// Agents the stop gate applies to end with text, not a schema: a block after
// a StructuredOutput call comes too late, the workflow has taken the result
// (spike 3 of #17). The script reads the closing lines instead.
const ENDING = `

End your final message with these three lines, nothing after them:
STATUS: ok | needs-human | stuck
SUMMARY: <one line: what you did, or why you stopped>
COMMITS: <the oneline of each commit you made, separated by " ; ", or none>`;

async function work(name, prompt, opts) {
  const text = await agent(`${HEAD}\n\n${prompt}${ENDING}`, {
    label: `${name}:#${issue}`,
    ...opts,
  });
  if (!text) throw new Error(`${name} returned nothing`);
  const field = (key) => [...text.matchAll(new RegExp(`^${key}: *(.*)$`, 'gm'))].at(-1)?.[1].trim();
  const status = field('STATUS');
  const result = {
    status: ['ok', 'needs-human', 'stuck'].includes(status) ? status : 'stuck',
    summary: field('SUMMARY') ?? text.slice(-500),
    commits: (field('COMMITS') ?? '').split(' ; ').filter((c) => c && c !== 'none'),
  };
  report.stages[name] = result;
  return result;
}

// The approved tests are red once committed, and the stop gate blocks any
// agent but the test-writer and the reviewer that stops with red committed
// tests; so the test-writer commits them.
async function commitTests() {
  const commit = await work(
    'commit-tests',
    `Commit the new and changed test files on their own, nothing else: stage only them, message \`Add failing tests for <what>\` (sentence case, the attribution line from your instructions). If they are already committed, change nothing.`,
    { phase: 'Red', agentType: 'test-writer' },
  );
  return commit;
}

if (run === 'all' || run === 'red') {
  phase('Spec');
  const spec = await step(
    'spec',
    `Review the spec of issue #${issue} before any test exists (semi-auto-workflow step 4, "Spec review"): the issue, the docs it links (docs/plan/overview.md, the plan, the ADRs) and the code it builds on in the worktree. Lens: does each criterion serve the issue's goal and the use case; does it contradict the plan, an ADR, a never-break rule in CLAUDE.md or earlier code; is it complete (edge cases, roles, error paths, what later slices need); is each criterion testable and unambiguous. Report conflicts separately from ambiguities; give each ambiguity the most conservative reading. Also say whether the slice touches database security and whether it changes screens.`,
    { phase: 'Spec', agentType: 'reviewer', schema: SPEC },
  );
  if (spec.result === 'conflict') return stop('needs-human', 'spec', spec.conflicts);

  phase('Red');
  const readings = spec.readings.length
    ? `Readings from the spec review (take them as part of the spec):\n- ${spec.readings.join('\n- ')}`
    : 'Spec review: PASS.';
  let tests = await step(
    'tests',
    `Turn the acceptance criteria of issue #${issue} into failing tests in the worktree. ${readings}\nRun them and confirm each fails for the right reason (missing table, function or screen, not a typo or broken fixture). Don't commit.`,
    { phase: 'Red', agentType: 'test-writer', schema: TESTS },
  );
  const reviewTests = (round) =>
    step(
      `test-review-${round}`,
      `Review the uncommitted test files in the worktree (semi-auto-workflow step 4, gate 1 list item 2). The contract: issue #${issue} plus these readings: ${readings}\nLens: every criterion is covered; each policy has a positive and a negative test per role (anon, learner, admin, plus an anonymous user where the issue names one); no test can pass for the wrong reason; no test pins behavior the spec doesn't ask for; the tests can pass once implemented. Mark a finding blocker only when the tests can't serve as the spec without fixing it.`,
      { phase: 'Red', agentType: 'reviewer', schema: REVIEW },
    );
  let review = await reviewTests(1);
  if (review.findings.length || !tests.failsForRightReason) {
    tests = await step(
      'tests-fix',
      `Fix the uncommitted tests per these review findings, and fix tests that fail for the wrong reason (${(tests.wrongReasons ?? []).join('; ') || 'none'}). Accept a finding unless it contradicts the spec; for each rejected or deferred one, say why. Findings:\n${JSON.stringify(review.findings, null, 2)}\nRerun the tests and confirm each still fails for the right reason. Don't commit.`,
      { phase: 'Red', agentType: 'test-writer', schema: TESTS },
    );
    review = await reviewTests(2);
    if (review.blockers || !tests.failsForRightReason)
      return stop('needs-human', 'test-review', review.findings);
  }
  // The test-writer itself asks for the human (a re-spec it can't settle,
  // an ambiguity), or is stuck.
  if (tests.status !== 'ok') return stop(tests.status, 'tests', tests.designChoices);
  report.gate1 = tests.gate1;
  report.dbSecurity = spec.dbSecurity;
  report.ui = ui ?? spec.ui;
  if (spec.dbSecurity || run === 'red') return { ...report, status: 'gate1' };
  await work(
    'log-tests',
    `Log every design choice the tests pin down and every rejected or deferred review finding in the decision log, and change nothing else (don't commit):\n${JSON.stringify({ designChoices: tests.designChoices, findings: review.findings }, null, 2)}`,
    { phase: 'Red' },
  );
  const committed = await commitTests();
  if (committed.status !== 'ok') return stop(committed.status, 'commit-tests', committed.summary);
} else if (run === 'green') {
  phase('Red');
  report.ui = ui ?? false;
  if (ui === undefined) log('args.ui not given: the ui-verifier is skipped');
  await work(
    'log-tests',
    `The human approved the uncommitted failing tests at gate 1. Log every decision the orchestrator's notes carry over from the red run (design choices the tests pin, rejected or deferred review findings) in the decision log, unless it is already there. Change nothing else (don't commit).`,
    { phase: 'Red' },
  );
  const committed = await commitTests();
  if (committed.status !== 'ok') return stop(committed.status, 'commit-tests', committed.summary);
} else {
  throw new Error(`unknown phase ${run}`);
}

phase('Green');
const green = await work(
  'green',
  `Make the committed failing tests pass with the least production code (feature-slice step 3). The tests are the spec: never edit a committed test to make it pass. If one looks wrong against the spec, stop with status needs-human and say why (a re-spec goes through the human). The post-edit hook reports problems after each edit; fix them as they come. Cap: about 10 attempts; if stuck, write ${WT}/.claude/state/escalation.md (tried, observed, stuck where) and stop with status stuck. Then refactor without adding anything (feature-slice step 4), tests green. Commit by concern (one concern per commit, stage only your files, sentence case, the attribution line). Log implementation choices beyond the tests.`,
  { phase: 'Green' },
);
if (green.status !== 'ok') return stop(green.status, 'green', green.summary);

const verifyPrompt = `Verify the slice (semi-auto-workflow step 5.1), each in \`cd ${WT} && …\`:
- \`npm run -s check\`;
- when the branch touches supabase/: \`npx supabase start\` (the worktree's own stack), \`npx supabase db reset && npx supabase test db\`, and \`npm run db:types\` after schema changes (commit a changed src/types/database.ts on its own);
- when the app or the e2e setup changed: \`npm run test:e2e\` (it takes the machine-wide e2e lock itself and may wait for it).
Fix what is red in production code (never weaken a committed test; a wrong test means status needs-human). Report the decisive output of each command. Commit fixes by concern.`;

phase('Verify');
let verify = await work('verify', verifyPrompt, { phase: 'Verify' });
if (verify.status !== 'ok') return stop(verify.status, 'verify', verify.summary);

if (report.ui) {
  const web = ports.web ?? 8081;
  const ui = await work(
    'ui-start',
    `Start the web dev server for the ui-verifier so that it outlives you (a later step stops it): \`cd ${WT} && setsid nohup npx expo start --web --port ${web} > ${WT}/.claude/state/dev-server.log 2>&1 &\`, then wait until http://localhost:${web} answers (poll with curl, at most 3 minutes; on timeout report the log's tail and status stuck).`,
    { phase: 'Verify' },
  );
  if (ui.status === 'ok') {
    await step(
      'ui-verifier',
      `Check the running app at http://localhost:${web} at phone and desktop width against the acceptance criteria of issue #${issue} (gh issue view ${issue}). If the Playwright MCP tools aren't available to you, say so as your only finding.`,
      { phase: 'Verify', agentType: 'ui-verifier' },
    );
  }
  await work(
    'ui-stop',
    `Stop the dev server on port ${web} that a previous step started for this worktree (find its PID with \`lsof -ti tcp:${web}\` or \`fuser ${web}/tcp\`; kill only that process). Then fix in production code what the ui-verifier found that breaks an acceptance criterion:\n${report.stages['ui-verifier'] ?? '(the ui-verifier did not run)'}\nRerun \`npm run -s check\` after a fix; commit by concern.`,
    { phase: 'Verify' },
  );
}

phase('Review');
for (let round = 1; round <= 3; round++) {
  const review = await step(
    `review-${round}`,
    `Review the branch diff against ${base} plus uncommitted changes, as the reviewer agent does; check every changed committed test for weakening. Mark a finding blocker when it breaks a criterion, a never-break rule or security.`,
    { phase: 'Review', agentType: 'reviewer', schema: REVIEW },
  );
  if (!review.findings.length) break;
  if (round === 3) {
    report.openPoints = review.findings;
    break;
  }
  const fix = await work(
    `fix-${round}`,
    `Triage these review findings (accept, reject with a reason, defer) and fix the accepted ones in production code; a finding that needs a committed test changed means status needs-human (re-spec). Log rejected and deferred ones in the decision log. Rerun \`npm run -s check\` (and pgTAP when supabase/ changed); commit by concern.\n${JSON.stringify(review.findings, null, 2)}`,
    { phase: 'Review' },
  );
  if (fix.status !== 'ok') return stop(fix.status, `fix-${round}`, fix.summary);
}

const final = await work(
  'final',
  `Final state of the slice, for the orchestrator's PR: run \`cd ${WT} && npm run -s check\` and \`git -C ${WT} status --short\` (must be clean: commit leftovers by concern, or report them), and \`git -C ${WT} log --oneline ${base}..HEAD\`. List every commit of the branch in COMMITS and the check result in SUMMARY.`,
  { phase: 'Review' },
);
return {
  ...report,
  status: final.status === 'ok' ? 'ready' : final.status,
  commits: final.commits,
};
