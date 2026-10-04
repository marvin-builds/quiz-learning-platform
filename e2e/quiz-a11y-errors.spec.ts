import { expect, type Locator, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';

// Keyboard use, accessible structure, error recovery and the page title of
// the quiz screen, on the seeded quiz "Hauptstädte Europas"
// (supabase/seed.sql): two single choice questions, then a multiple choice
// one with three of four answers correct. Runs once per project in
// playwright.config.ts (phone and desktop); every test starts in a fresh
// browser context without a session.

const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';
const FLUESSE_DRAFT = '20000000-0000-4000-8000-000000000002';

const FRANCE = 'Was ist die Hauptstadt von Frankreich?';
const ITALY = 'Was ist die Hauptstadt von Italien?';
const DANUBE = 'Welche dieser Hauptstädte liegen an der Donau?';

// How long an error may take to show once a request can't reach the server.
// An error that never shows (a hung request) fails here instead of after the
// whole test timeout.
const ERROR_SHOWS_WITHIN = { timeout: 5_000 };

// Reads a text from de.json by path, so keys that don't exist yet fail at run
// time with their name instead of breaking the typecheck. Fills in
// {{placeholders}} like i18next does.
function text(key: string, values: Record<string, string | number> = {}): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
  if (typeof value !== 'string') throw new Error(`de.json has no text for ${key}`);
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(values[name]));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isRpc = (name: string, url: string) => new URL(url).pathname === `/rest/v1/rpc/${name}`;

const button = (page: Page, key: string) =>
  page.getByRole('button', { name: text(key), exact: true });

async function start(page: Page) {
  const response = page.waitForResponse((candidate) => isRpc('start_attempt', candidate.url()));
  await button(page, 'quiz.start').click();
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
  await button(page, 'quiz.submit').click();
  expect((await response).ok()).toBe(true);
}

// After an answer is recorded, its feedback shows until Next is pressed.
async function next(page: Page) {
  await button(page, 'quiz.next').click();
}

// Opens the quiz, starts it and answers the two single choice questions, so
// the multiple choice question is on screen.
async function reachMultipleChoice(page: Page) {
  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  await start(page);
  await pickAndSubmit(page, 'radio', ['Paris']);
  await next(page);
  await expect(page.getByText(ITALY, { exact: true })).toBeVisible();
  await pickAndSubmit(page, 'radio', ['Rom']);
  await next(page);
  await expect(page.getByText(DANUBE, { exact: true })).toBeVisible();
}

// Presses Tab until the target has the focus, as a keyboard user would.
async function tabTo(page: Page, target: Locator) {
  for (let presses = 0; presses < 40; presses += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Tab never reached the target');
}

test('a keyboard user picks a single choice answer with Tab and Space', async ({ page }) => {
  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  await start(page);
  const paris = page.getByRole('radio', { name: 'Paris', exact: true });

  await tabTo(page, paris);
  await page.keyboard.press('Space');

  await expect(paris).toBeChecked();
  await expect(paris).toHaveAttribute('aria-checked', 'true');
  await expect(button(page, 'quiz.submit')).toBeEnabled();
});

test('a keyboard user toggles a multiple choice answer with Space', async ({ page }) => {
  await reachMultipleChoice(page);
  const vienna = page.getByRole('checkbox', { name: 'Wien', exact: true });

  await vienna.focus();
  await page.keyboard.press('Space');
  await expect(vienna).toBeChecked();
  await expect(button(page, 'quiz.submit')).toBeEnabled();

  await page.keyboard.press('Space');
  await expect(vienna).not.toBeChecked();
});

test('retry after a failed submit is disabled without a pick, and sends the picks once there are some', async ({
  page,
}) => {
  await reachMultipleChoice(page);
  // The next submit_answer request fails once with a server error.
  let failed = false;
  await page.route('**/rest/v1/rpc/submit_answer', async (route) => {
    if (failed || route.request().method() !== 'POST') return route.continue();
    failed = true;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ code: 'XX000', message: 'internal error' }),
    });
  });
  const answers = ['Wien', 'Bratislava', 'Budapest'];
  for (const answer of answers) {
    await page.getByRole('checkbox', { name: answer, exact: true }).click();
  }
  await button(page, 'quiz.submit').click();
  await expect(page.getByText(text('quiz.submitError'), { exact: true })).toBeVisible();
  const retry = button(page, 'quiz.retry');
  await expect(retry).toBeEnabled();

  for (const answer of answers) {
    const option = page.getByRole('checkbox', { name: answer, exact: true });
    await option.click();
    await expect(option).not.toBeChecked();
  }
  await expect(retry).toBeDisabled();

  await page.getByRole('checkbox', { name: 'Wien', exact: true }).click();
  await expect(retry).toBeEnabled();

  const response = page.waitForResponse((candidate) => isRpc('submit_answer', candidate.url()));
  await retry.click();
  const sent = await response;
  expect(sent.ok()).toBe(true);
  expect(sent.request().postDataJSON()).toMatchObject({ answer_ids: [expect.any(String)] });
  await expect(button(page, 'quiz.seeResult')).toBeVisible();
});

test('starting offline shows the start error with retry, and retry starts once back online', async ({
  page,
  context,
}) => {
  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  await expect(button(page, 'quiz.start')).toBeEnabled();

  await context.setOffline(true);
  await button(page, 'quiz.start').click();

  await expect(page.getByText(text('quiz.startError'), { exact: true })).toBeVisible(
    ERROR_SHOWS_WITHIN,
  );
  const retry = button(page, 'quiz.retry');
  await expect(retry).toBeVisible();

  await context.setOffline(false);
  await retry.click();

  await expect(page.getByText(FRANCE, { exact: true })).toBeVisible();
});

test('submitting offline shows the submit error with retry, and retry submits once back online', async ({
  page,
  context,
}) => {
  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  await start(page);
  await page.getByRole('radio', { name: 'Paris', exact: true }).click();

  await context.setOffline(true);
  await button(page, 'quiz.submit').click();

  await expect(page.getByText(text('quiz.submitError'), { exact: true })).toBeVisible(
    ERROR_SHOWS_WITHIN,
  );
  const retry = button(page, 'quiz.retry');
  await expect(retry).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Paris', exact: true })).toBeChecked();

  await context.setOffline(false);
  await retry.click();

  await expect(page.getByText(text('quiz.feedback.correct'), { exact: true })).toBeVisible();
  await next(page);
  await expect(page.getByText(ITALY, { exact: true })).toBeVisible();
});

test('the not-found quiz page has the quiz page title, not the category list title', async ({
  page,
}) => {
  await page.goto(`/quizzes/${FLUESSE_DRAFT}`);
  await expect(page.getByText(text('quiz.notFound'), { exact: true })).toBeVisible();

  await expect(page).not.toHaveTitle(new RegExp(escape(text('categories.title'))));
  await expect(page).toHaveTitle(text('quiz.pageTitle'));
});

test('each question is a heading, and the multiple choice group is described by its hint', async ({
  page,
}) => {
  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  await start(page);
  await expect(page.getByRole('heading', { name: FRANCE, exact: true })).toBeVisible();

  await pickAndSubmit(page, 'radio', ['Paris']);
  await next(page);
  await expect(page.getByRole('heading', { name: ITALY, exact: true })).toBeVisible();

  await pickAndSubmit(page, 'radio', ['Rom']);
  await next(page);
  await expect(page.getByRole('heading', { name: DANUBE, exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: DANUBE, exact: true })).toHaveAccessibleDescription(
    text('quiz.multipleHint'),
  );
});
