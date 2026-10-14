import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  test,
  type TestInfo,
} from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';
import { enterTotpCode, SEED_ADMIN, seedAdminAccessToken } from './admin-auth';

// Answers with single or multiple correct (#82) against the local stack: the
// seed admin (admin@example.com / admin-password) creates a quiz, adds a
// single-choice and a multiple-choice question with their answers inline
// (after a refused save that explains the missing correct answer), publishes
// the quiz from the list, and a learner (a fresh visitor, signed in
// anonymously) plays it to the result screen: 2 of 2 points. axe runs on the
// question form with answers, in its error state, on the quiz and on the
// result. Runs once per project in playwright.config.ts (phone and desktop).
//
// The database is shared by every spec, and this one publishes content a
// visitor can see, so it uses unique names per project and run, creates its
// own category through the API, and deletes it afterwards (its quizzes,
// questions and answers go with it), also when the test failed half-way.
// Other specs find seed content by name, never by the number of published
// categories or quizzes.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password';

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

// The stack the web export talks to: .env.local in a worktree, else .env.
function setting(name: string): string {
  for (const file of ['.env.local', '.env']) {
    const full = path.join(process.cwd(), file);
    if (!existsSync(full)) continue;
    const line = readFileSync(full, 'utf8')
      .split('\n')
      .find((candidate) => candidate.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  }
  throw new Error(`Neither .env.local nor .env sets ${name}`);
}

// Collects console errors and page errors over the whole test.
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function signInAsAdmin(page: Page) {
  await page.goto('/admin/sign-in');
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  // Re-spec (#116): the sign-in lands on the category list, not the dashboard.
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(
    page.getByRole('heading', { name: text('admin.categories.title'), exact: true }),
  ).toBeVisible();
}

// The admin's API headers, as supabase-js sends them after signing in.
async function adminHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const key = setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  // Re-spec (#122): admin rights need an aal2 session (password and TOTP).
  const token = await seedAdminAccessToken(request);
  return { apikey: key, Authorization: `Bearer ${token}` };
}

const control = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true }));

const toggle = (page: Page, name: string) =>
  page
    .getByRole('switch', { name, exact: true })
    .or(page.getByRole('checkbox', { name, exact: true }))
    .or(page.getByRole('radio', { name, exact: true }));

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

const button = (page: Page, key: string) =>
  page.getByRole('button', { name: text(key), exact: true });

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Unique per project and run, so parallel projects and reruns don't collide.
const unique = (testInfo: TestInfo, what: string) =>
  `E2E ${what} ${testInfo.project.name} ${Date.now()}`;

const created: string[] = [];

// Removes the test's category (its quizzes, questions and answers cascade),
// also when a test failed half-way.
test.afterEach(async ({ request }) => {
  const ids = created.splice(0);
  if (ids.length === 0) return;
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const headers = await adminHeaders(request);
  for (const id of ids) {
    const response = await request.delete(`${apiUrl}/rest/v1/categories?id=eq.${id}`, {
      headers,
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
});

// A new published category, created as the admin through the API, so the
// learner can reach the quiz once it is published.
async function createCategory(request: APIRequestContext, name: string): Promise<string> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const response = await request.post(`${apiUrl}/rest/v1/categories?select=id`, {
    headers: { ...(await adminHeaders(request)), Prefer: 'return=representation' },
    data: { name, description: 'Angelegt vom E2E-Test', published: true },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const [{ id }] = (await response.json()) as { id: string }[];
  created.push(id);
  return id;
}

const answerField = (page: Page, number: number) =>
  page.getByLabel(text('admin.questions.form.answers.text', { number }), { exact: true });

const correctToggle = (page: Page, number: number) =>
  toggle(page, text('admin.questions.form.answers.correct', { number }));

// Fills the question form: text, choice type and the answers, top to bottom.
async function fillQuestion(
  page: Page,
  question: string,
  multiple: boolean,
  answers: { text: string; correct: boolean }[],
) {
  await page.getByLabel(text('admin.questions.form.text'), { exact: true }).fill(question);
  const multipleToggle = toggle(page, text('admin.questions.form.multipleCorrect'));
  if ((await multipleToggle.isChecked()) !== multiple) await multipleToggle.click();
  // The form starts with two answers.
  for (let number = 3; number <= answers.length; number += 1) {
    await button(page, 'admin.questions.form.answers.add').click();
  }
  for (const [index, answer] of answers.entries()) {
    await answerField(page, index + 1).fill(answer.text);
    if (answer.correct) {
      await correctToggle(page, index + 1).click();
      await expect(correctToggle(page, index + 1)).toBeChecked();
    }
  }
}

// A fresh browser context, as the project configures pages: no session.
async function newVisitor(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const { baseURL, viewport, locale } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport, locale });
  return context.newPage();
}

// An answer's radio or checkbox on the quiz screen; after submitting, its
// name may carry the mark before or after the answer text.
const option = (page: Page, role: 'radio' | 'checkbox', answer: string) =>
  page.getByRole(role, {
    name: new RegExp(`^${escape(answer)}(?!\\w)|(?<!\\w)${escape(answer)}$`),
  });

test('an admin writes a single- and a multiple-choice question with answers, publishes the quiz, and a learner plays it to the result', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const errors = watchErrors(page);
  const category = unique(testInfo, 'Kategorie');
  const quiz = unique(testInfo, 'Quiz');
  const single = `${unique(testInfo, 'Einfachauswahl')}?`;
  const multiple = `${unique(testInfo, 'Mehrfachauswahl')}?`;
  const categoryId = await createCategory(request, category);

  await signInAsAdmin(page);

  // The quiz, unpublished, through the form.
  await page.goto(`/admin/categories/${categoryId}/quizzes/new`);
  await page.getByLabel(text('admin.quizzes.form.title'), { exact: true }).fill(quiz);
  await page.getByRole('button', { name: text('admin.quizzes.form.save'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${categoryId}/?$`));
  await control(page, text('admin.quizzes.actions.questions', { name: quiz })).click();
  await expect(page).toHaveURL(/\/admin\/quizzes\/[0-9a-f-]{36}\/?$/);
  const quizId = /\/admin\/quizzes\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;

  // The single-choice question: first saved without a correct answer, which
  // the form refuses with its explanation, then with Rom marked.
  await control(page, text('admin.questions.create')).click();
  await expect(heading(page, text('admin.questions.form.createTitle'))).toBeVisible();
  await expect(answerField(page, 1)).toBeVisible();
  await expect(answerField(page, 2)).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await fillQuestion(page, single, false, [
    { text: 'Mailand', correct: false },
    { text: 'Rom', correct: false },
    { text: 'Neapel', correct: false },
  ]);
  await page.getByRole('button', { name: text('admin.questions.form.save'), exact: true }).click();
  const missing = page.getByText(text('admin.questions.form.errors.correctMissing'), {
    exact: true,
  });
  await expect(missing).toBeVisible();
  await expect(page).toHaveURL(/\/questions\/new\/?$/);
  await expectNoSeriousAxeViolations(page);
  await correctToggle(page, 2).click();
  await page.getByRole('button', { name: text('admin.questions.form.save'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${quizId}/?$`));
  await expect(page.getByText(single, { exact: true })).toBeVisible();

  // The multiple-choice question: Wien and Budapest are correct.
  await control(page, text('admin.questions.create')).click();
  await expect(heading(page, text('admin.questions.form.createTitle'))).toBeVisible();
  await fillQuestion(page, multiple, true, [
    { text: 'Wien', correct: true },
    { text: 'Prag', correct: false },
    { text: 'Budapest', correct: true },
  ]);
  await expectNoSeriousAxeViolations(page);
  await page.getByRole('button', { name: text('admin.questions.form.save'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${quizId}/?$`));
  await expect(page.getByText(multiple, { exact: true })).toBeVisible();

  // The edit form reads the answers back with their marks.
  await control(page, text('admin.questions.actions.edit', { name: multiple })).click();
  await expect(answerField(page, 3)).toHaveValue('Budapest');
  await expect(correctToggle(page, 1)).toBeChecked();
  await expect(correctToggle(page, 2)).not.toBeChecked();
  await expect(correctToggle(page, 3)).toBeChecked();
  await expectNoSeriousAxeViolations(page);

  // Publish from the category's quiz list.
  await page.goto(`/admin/categories/${categoryId}`);
  await control(page, text('admin.quizzes.actions.publish', { name: quiz })).click();
  await expect(
    control(page, text('admin.quizzes.actions.unpublish', { name: quiz })),
  ).toBeVisible();
  await expect(page.getByText(text('admin.quizzes.errors.publishRules'))).toHaveCount(0);

  // A learner plays it in a browser of their own.
  const learner = await newVisitor(browser, testInfo);
  const learnerErrors = watchErrors(learner);
  try {
    await learner.goto(`/quizzes/${quizId}`);
    await expect(learner.getByText(quiz).first()).toBeVisible();
    await button(learner, 'quiz.start').click();
    await expect(learner.getByText(single, { exact: true })).toBeVisible();
    await expectNoSeriousAxeViolations(learner);

    await option(learner, 'radio', 'Rom').click();
    await button(learner, 'quiz.submit').click();
    await expect(learner.getByText(text('quiz.feedback.correct'), { exact: true })).toBeVisible();
    await button(learner, 'quiz.next').click();

    await expect(learner.getByText(multiple, { exact: true })).toBeVisible();
    await option(learner, 'checkbox', 'Wien').click();
    await option(learner, 'checkbox', 'Budapest').click();
    await button(learner, 'quiz.submit').click();
    await expect(learner.getByText(text('quiz.feedback.correct'), { exact: true })).toBeVisible();
    await button(learner, 'quiz.seeResult').click();

    await expect(learner.getByText(text('quiz.result.title'), { exact: true })).toBeVisible();
    await expect(learner.getByText(/(^|\D)2 von 2 Punkten(?!\w)/)).toBeVisible();
    await expect(learner.getByText(/(^|\D)100\s%/)).toBeVisible();
    await expectNoSeriousAxeViolations(learner);
    expect(learnerErrors).toEqual([]);
  } finally {
    await learner.context().close();
  }

  expect(errors).toEqual([]);
});

test('the database refuses to publish a quiz without questions, and the list explains why', async ({
  page,
  request,
}, testInfo) => {
  const quiz = unique(testInfo, 'Leeres Quiz');
  const categoryId = await createCategory(request, unique(testInfo, 'Kategorie'));
  await signInAsAdmin(page);

  await page.goto(`/admin/categories/${categoryId}/quizzes/new`);
  await page.getByLabel(text('admin.quizzes.form.title'), { exact: true }).fill(quiz);
  await page.getByRole('button', { name: text('admin.quizzes.form.save'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${categoryId}/?$`));

  await control(page, text('admin.quizzes.actions.publish', { name: quiz })).click();

  await expect(
    page.getByText(text('admin.quizzes.errors.publishRules'), { exact: true }),
  ).toBeVisible();
  await expect(control(page, text('admin.quizzes.actions.publish', { name: quiz }))).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});
