import { expect, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// Playing the seeded quiz "Hauptstädte Europas" (supabase/seed.sql) as an
// anonymous visitor: two single choice questions, then a multiple choice one
// with three of four answers correct. Runs once per project in
// playwright.config.ts (phone and desktop). Every test runs in a fresh
// browser context, so it starts without a session; the attempts it creates
// are its own.

const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';
const FLUESSE_DRAFT = '20000000-0000-4000-8000-000000000002';
const KOMPONISTEN_IN_HIDDEN_CATEGORY = '20000000-0000-4000-8000-000000000004';

const FRANCE = 'Was ist die Hauptstadt von Frankreich?';
const ITALY = 'Was ist die Hauptstadt von Italien?';
const DANUBE = 'Welche dieser Hauptstädte liegen an der Donau?';

// The keys are added in this slice; the de.json import is typed, so read them
// by path to keep this file compiling while they don't exist yet. Fills in
// {{placeholders}} like i18next does.
function text(key: string, values: Record<string, string | number> = {}): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
  if (typeof value !== 'string') throw new Error(`de.json has no text for ${key}`);
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(values[name]));
}

// Counts anonymous sign-ups (supabase-js posts them to /auth/v1/signup) and
// collects console errors over the whole test.
function watch(page: Page) {
  const seen = { signUps: 0, errors: [] as string[] };
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/auth/v1/signup') {
      seen.signUps += 1;
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') seen.errors.push(message.text());
  });
  page.on('pageerror', (error) => seen.errors.push(error.message));
  return seen;
}

const isRpc = (name: string, url: string) => new URL(url).pathname === `/rest/v1/rpc/${name}`;

async function start(page: Page) {
  const response = page.waitForResponse((candidate) => isRpc('start_attempt', candidate.url()));
  await page.getByRole('button', { name: text('quiz.start'), exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByText(FRANCE, { exact: true })).toBeVisible();
}

async function pickAndSubmit(page: Page, role: 'radio' | 'checkbox', answers: string[]) {
  for (const answer of answers) {
    const option = page.getByRole(role, { name: answer, exact: true });
    await option.click();
    await expect(option).toBeChecked();
  }
  const response = page.waitForResponse((candidate) => isRpc('submit_answer', candidate.url()));
  await page.getByRole('button', { name: text('quiz.submit'), exact: true }).click();
  expect((await response).ok()).toBe(true);
}

// After an answer is recorded, its feedback shows until Next is pressed.
async function next(page: Page) {
  await page.getByRole('button', { name: text('quiz.next'), exact: true }).click();
}

test('an anonymous visitor starts and finishes the seeded quiz, and the quiz passes axe', async ({
  page,
}) => {
  const seen = watch(page);

  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);

  await expect(page.getByText('Hauptstädte Europas').first()).toBeVisible();
  await expect(page.getByText('Kennst du die Hauptstädte unserer Nachbarn?')).toBeVisible();
  await expect(
    page.getByText(text('quiz.questionCount_other', { count: 3 }), { exact: true }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  await start(page);
  await expect(
    page.getByText(text('quiz.progress', { current: 1, total: 3 }), { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: text('quiz.submit'), exact: true })).toBeDisabled();
  await expectNoSeriousAxeViolations(page);

  await pickAndSubmit(page, 'radio', ['Paris']);
  await next(page);
  await expect(page.getByText(ITALY, { exact: true })).toBeVisible();
  await expect(
    page.getByText(text('quiz.progress', { current: 2, total: 3 }), { exact: true }),
  ).toBeVisible();

  await pickAndSubmit(page, 'radio', ['Rom']);
  await next(page);
  await expect(page.getByText(DANUBE, { exact: true })).toBeVisible();
  await expect(page.getByText(text('quiz.multipleHint'), { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  await pickAndSubmit(page, 'checkbox', ['Wien', 'Bratislava', 'Budapest']);
  await page.getByRole('button', { name: text('quiz.seeResult'), exact: true }).click();

  await expect(page.getByText(text('quiz.result.title'), { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  expect(seen.signUps).toBe(1);
  expect(seen.errors).toEqual([]);
});

test('after a reload, a second Start reuses the anonymous session instead of signing up again', async ({
  page,
}) => {
  const seen = watch(page);

  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  await start(page);

  await page.reload();
  await start(page);

  expect(seen.signUps).toBe(1);
  expect(seen.errors).toEqual([]);
});

test('an unpublished quiz shows the not-found state', async ({ page }) => {
  const seen = watch(page);

  await page.goto(`/quizzes/${FLUESSE_DRAFT}`);

  await expect(page.getByText(text('quiz.notFound'), { exact: true })).toBeVisible();
  await expect(page.getByText('Flüsse in Deutschland')).toHaveCount(0);
  await expect(page.getByRole('button', { name: text('quiz.start'), exact: true })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
  expect(seen.errors).toEqual([]);
});

test('a published quiz in an unpublished category shows the not-found state', async ({ page }) => {
  const seen = watch(page);

  await page.goto(`/quizzes/${KOMPONISTEN_IN_HIDDEN_CATEGORY}`);

  await expect(page.getByText(text('quiz.notFound'), { exact: true })).toBeVisible();
  await expect(page.getByText('Komponisten')).toHaveCount(0);
  await expect(page.getByRole('button', { name: text('quiz.start'), exact: true })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
  expect(seen.errors).toEqual([]);
});
