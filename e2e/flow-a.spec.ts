import { expect, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// E2E flow A on the seed content (supabase/seed.sql): an anonymous visitor
// opens Geografie from the category list, plays "Hauptstädte Europas" with
// one correct (Paris), one wrong (Mailand) and one partly correct multiple
// choice answer (Wien and Bratislava, two of the three correct ones), sees
// each verdict and the explanations, and on the result screen the score the
// database computed: 1 + 0 + 0,67 = 1,67 of 3 points, 56 %. Runs once per
// project in playwright.config.ts (phone and desktop); every test starts in
// a fresh browser context without a session, so its attempts are its own.

const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';

const FRANCE = 'Was ist die Hauptstadt von Frankreich?';
const ITALY = 'Was ist die Hauptstadt von Italien?';
const DANUBE = 'Welche dieser Hauptstädte liegen an der Donau?';
const FRANCE_EXPLANATION = 'Paris ist seit dem Mittelalter die Hauptstadt Frankreichs.';
const DANUBE_EXPLANATION = 'Wien, Bratislava und Budapest liegen an der Donau, Prag an der Moldau.';

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

// Starts the quiz and returns the id of the attempt start_attempt created.
async function start(page: Page, key = 'quiz.start'): Promise<string> {
  const response = page.waitForResponse((candidate) => isRpc('start_attempt', candidate.url()));
  await button(page, key).click();
  const started = await response;
  expect(started.ok()).toBe(true);
  await expect(page.getByText(FRANCE, { exact: true })).toBeVisible();
  return (await started.json()) as string;
}

// An answer's radio or checkbox; after submitting, its name may carry the
// mark before or after the answer text.
const option = (page: Page, role: 'radio' | 'checkbox', answer: string) =>
  page.getByRole(role, {
    name: new RegExp(`^${escape(answer)}(?!\\w)|(?<!\\w)${escape(answer)}$`),
  });

async function pickAndSubmit(page: Page, role: 'radio' | 'checkbox', answers: string[]) {
  for (const answer of answers) {
    await option(page, role, answer).click();
    await expect(option(page, role, answer)).toBeChecked();
  }
  const response = page.waitForResponse((candidate) => isRpc('submit_answer', candidate.url()));
  await button(page, 'quiz.submit').click();
  expect((await response).ok()).toBe(true);
}

// The answer is marked with the text of `mark`, visible inside the answer and
// in its accessible name or description, so the mark isn't color alone.
async function expectMarked(
  page: Page,
  role: 'radio' | 'checkbox',
  answer: string,
  mark: 'pickedCorrect' | 'pickedWrong' | 'missed',
) {
  const markText = text(`quiz.feedback.${mark}`);
  const target = option(page, role, answer);
  await expect(target).toBeDisabled();
  await expect(target.getByText(markText)).toBeVisible();
  await expect
    .poll(async () => {
      const named = await page
        .getByRole(role, {
          name: new RegExp(`(?=.*(^|\\W)${escape(answer)}(?!\\w))(?=.*${escape(markText)})`),
        })
        .count();
      const description = await target.evaluate((element) =>
        (element.getAttribute('aria-describedby') ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      return named > 0 || description.includes(markText);
    })
    .toBe(true);
}

test('flow A: an anonymous visitor plays the seeded quiz from its category to the result, and every screen passes axe', async ({
  page,
}) => {
  const seen = watch(page);

  await page.goto('/');
  await expect(page.getByRole('link', { name: /Geografie/ })).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  await page.getByRole('link', { name: /Geografie/ }).click();
  await expect(page).toHaveURL(new RegExp(`/categories/${GEOGRAFIE}$`));
  const quizLink = page.getByRole('link', { name: /Hauptstädte Europas/ });
  await expect(quizLink).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  await quizLink.click();
  await expect(page).toHaveURL(new RegExp(`/quizzes/${HAUPTSTAEDTE}$`));
  await expect(page.getByText('Kennst du die Hauptstädte unserer Nachbarn?')).toBeVisible();
  await expect(
    page.getByText(text('quiz.questionCount_other', { count: 3 }), { exact: true }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  await start(page);
  await expect(
    page.getByText(text('quiz.progress', { current: 1, total: 3 }), { exact: true }),
  ).toBeVisible();
  await expect(button(page, 'quiz.submit')).toBeDisabled();
  await expectNoSeriousAxeViolations(page);

  // France: correct, with its explanation.
  await pickAndSubmit(page, 'radio', ['Paris']);
  await expect(page.getByText(text('quiz.feedback.correct'), { exact: true })).toBeVisible();
  await expectMarked(page, 'radio', 'Paris', 'pickedCorrect');
  await expect(page.getByText(FRANCE_EXPLANATION, { exact: true })).toBeVisible();
  await expect(button(page, 'quiz.submit')).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
  await button(page, 'quiz.next').click();

  // Italy: wrong, Rom missed; the seed has no explanation for it.
  await expect(page.getByText(ITALY, { exact: true })).toBeVisible();
  await pickAndSubmit(page, 'radio', ['Mailand']);
  await expect(page.getByText(text('quiz.feedback.wrong'), { exact: true })).toBeVisible();
  await expectMarked(page, 'radio', 'Mailand', 'pickedWrong');
  await expectMarked(page, 'radio', 'Rom', 'missed');
  await expect(page.getByText(FRANCE_EXPLANATION, { exact: true })).toHaveCount(0);
  await expect(page.getByText(DANUBE_EXPLANATION, { exact: true })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
  await button(page, 'quiz.next').click();

  // The Danube: two of three correct answers, Budapest missed.
  await expect(page.getByText(DANUBE, { exact: true })).toBeVisible();
  await pickAndSubmit(page, 'checkbox', ['Wien', 'Bratislava']);
  await expect(page.getByText(/(^|\D)0,67 von 1 Punkt(?!\w)/)).toBeVisible();
  await expectMarked(page, 'checkbox', 'Wien', 'pickedCorrect');
  await expectMarked(page, 'checkbox', 'Bratislava', 'pickedCorrect');
  await expectMarked(page, 'checkbox', 'Budapest', 'missed');
  await expect(page.getByText(DANUBE_EXPLANATION, { exact: true })).toBeVisible();
  await expect(button(page, 'quiz.next')).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
  await button(page, 'quiz.seeResult').click();

  // The result the database computed.
  await expect(page.getByText(text('quiz.result.title'), { exact: true })).toBeVisible();
  await expect(page.getByText(/(^|\D)1,67 von 3 Punkten(?!\w)/)).toBeVisible();
  await expect(page.getByText(/(^|\D)56\s%/)).toBeVisible();
  await expect(button(page, 'quiz.result.playAgain')).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  await page.getByRole('link', { name: text('quiz.result.backToCategory') }).click();
  await expect(page).toHaveURL(new RegExp(`/categories/${GEOGRAFIE}$`));
  await expect(page.getByRole('link', { name: /Hauptstädte Europas/ })).toBeVisible();

  expect(seen.signUps).toBe(1);
  expect(seen.errors).toEqual([]);
});

test('Play again on the result starts a new attempt at question 1 with nothing picked', async ({
  page,
}) => {
  const seen = watch(page);

  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  const first = await start(page);
  await pickAndSubmit(page, 'radio', ['Paris']);
  await button(page, 'quiz.next').click();
  await pickAndSubmit(page, 'radio', ['Rom']);
  await button(page, 'quiz.next').click();
  await pickAndSubmit(page, 'checkbox', ['Wien', 'Bratislava', 'Budapest']);
  await button(page, 'quiz.seeResult').click();
  await expect(page.getByText(/(^|\D)3 von 3 Punkten(?!\w)/)).toBeVisible();
  await expect(page.getByText(/(^|\D)100\s%/)).toBeVisible();

  const second = await start(page, 'quiz.result.playAgain');

  expect(second).not.toBe(first);
  await expect(
    page.getByText(text('quiz.progress', { current: 1, total: 3 }), { exact: true }),
  ).toBeVisible();
  for (const answer of ['Paris', 'Lyon', 'Marseille']) {
    await expect(option(page, 'radio', answer)).not.toBeChecked();
  }
  await expect(button(page, 'quiz.submit')).toBeDisabled();
  await expect(page.getByText(text('quiz.result.title'), { exact: true })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
  expect(seen.signUps).toBe(1);
  expect(seen.errors).toEqual([]);
});
