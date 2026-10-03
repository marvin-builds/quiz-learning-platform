---
name: e2e-flow
description: Writing and debugging the Playwright e2e tests in e2e/ - selectors, waiting, database state, axe, traces. Use when an issue asks for e2e coverage, when writing or changing a spec in e2e/, or when an e2e run fails locally or in CI.
---

# E2E flow

The e2e tests run Playwright in Chromium against the static web export, at
phone and desktop width (the two projects in `playwright.config.ts`), with
the app talking to the local Supabase stack. `CLAUDE.md` → Commands has the
commands and the one-time setup.

## Each run starts from a reset database

```sh
npx supabase start && npx supabase db reset && npm run test:e2e
```

`db reset` rebuilds the database from the migrations and seeds it, so every
run sees the same data, and CI does the same. A spec may rely on the seed
data, never on what an earlier spec or run created. A spec that writes
(attempts, answers) creates what it needs itself, so specs stay independent
of order and of the two projects running the same spec.

## Selectors: role and translated text

Find elements the way a user does: `page.getByRole('button', { name: … })`
first, then `getByText` or `getByLabel`. Take the name from the locale file,
not a literal, so a changed translation can't leave a test that matches
nothing:

```ts
import de from '../src/i18n/locales/de.json';

await expect(page.getByText(de.home.title, { exact: true })).toBeVisible();
```

The tests run with locale `de-DE`, the default language. No CSS classes,
generated test ids or DOM structure: they change with styling and say
nothing about what the user sees. If an element has no accessible role or
name, that's an accessibility bug in the app; fix it there.

## No sleeps

Never use `page.waitForTimeout` or any other fixed wait; the repo test
`tests/repo/e2e-flow-skill.test.ts` fails a spec that does. Playwright's
actions and web-first assertions wait on their own
(`await expect(locator).toBeVisible()`). To wait for loading to end, assert
on what follows it, or that the loading text is hidden, as `e2e/app.spec.ts`
does. A test that only passes with a sleep has a race; find it.

## Accessibility

Call `expectNoSeriousAxeViolations(page)` from `e2e/axe.ts` on every screen
a spec reaches, once it has settled. It fails on serious and critical
violations and names each rule; fix the app, not the check.

## Console errors

Collect `console` errors and `pageerror` events and expect none, as
`e2e/app.spec.ts` does. An error logged by a screen that still renders is a
bug the user doesn't see.

## When a run fails

1. Read the failure in the `list` reporter output: which project (phone or
   desktop), which step, expected against received.
2. Open the trace. A failed test keeps one in `test-results/` (CI uploads
   that folder as an artifact):

   ```sh
   npx playwright show-trace test-results/<test-folder>/trace.zip
   ```

   It shows each action with the DOM before and after, the console and the
   network calls. A screenshot of the failure is next to it.

3. Rerun only that test: `npm run test:e2e -- e2e/<spec>.ts -g "<title>" --project=phone`.
4. Fails only in CI: download the `playwright-test-results` artifact and read its trace
   the same way. Timing differences point to a missing web-first assertion.

A flaky test is a bug: fix the cause or open an issue for it, never add a
retry or a sleep to hide it.
