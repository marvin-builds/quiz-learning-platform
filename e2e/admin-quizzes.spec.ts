import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type APIRequestContext, expect, type Page, test, type TestInfo } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// The quiz and question editor (#81) against the local stack: the seed admin
// (supabase/seed.sql, admin@example.com / admin-password) opens a category's
// quiz list, creates a quiz in it, then a question with an explanation and
// multiple_correct, and reopens the question's edit form, which shows the
// explanation again: that is the admin's read path (admin_question) end to
// end. axe runs on the quiz form and the question form, in create and edit
// mode. Runs once per project in playwright.config.ts (phone and desktop).
//
// The database is shared by every spec, so this one never touches seed
// content: it creates its own category, unpublished (so no learner flow or
// count in another spec sees it), through the API as the admin, and deletes
// it afterwards, which deletes its quizzes and questions with it.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password';

// Reads a text from de.json by path, so keys that don't exist yet fail at run
// time with their name instead of breaking the typecheck.
function text(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
  if (typeof value !== 'string') throw new Error(`de.json has no text for ${key}`);
  return value;
}

// A text with its {{name}} placeholder filled in, as the screen's t() does.
function label(key: string, name: string): string {
  return text(key).replace(/\{\{\s*name\s*\}\}/g, name);
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
  await expect(page.getByText(text('admin.dashboard.title'), { exact: true })).toBeVisible();
}

// The admin's API headers, as supabase-js sends them after signing in.
async function adminHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const key = setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const signIn = await request.post(`${apiUrl}/auth/v1/token?grant_type=password`, {
    headers: { apikey: key },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(signIn.ok(), await signIn.text()).toBe(true);
  const { access_token: token } = (await signIn.json()) as { access_token: string };
  return { apikey: key, Authorization: `Bearer ${token}` };
}

const control = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true }));

const toggle = (page: Page, name: string) =>
  page
    .getByRole('switch', { name, exact: true })
    .or(page.getByRole('checkbox', { name, exact: true }));

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Unique per project and run, so parallel projects and reruns don't collide.
const unique = (testInfo: TestInfo, what: string) =>
  `E2E ${what} ${testInfo.project.name} ${Date.now()}`;

const created: string[] = [];

// Removes the test's category (its quizzes and questions cascade), also when
// a test failed half-way.
test.afterEach(async ({ request }) => {
  const ids = created.splice(0);
  if (ids.length === 0) return;
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const headers = await adminHeaders(request);
  for (const id of ids) {
    await request.delete(`${apiUrl}/rest/v1/categories?id=eq.${id}`, { headers });
  }
});

// A new unpublished category, created as the admin through the API.
async function createCategory(request: APIRequestContext, name: string): Promise<string> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const response = await request.post(`${apiUrl}/rest/v1/categories?select=id`, {
    headers: { ...(await adminHeaders(request)), Prefer: 'return=representation' },
    data: { name, description: 'Angelegt vom E2E-Test', published: false },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const [{ id }] = (await response.json()) as { id: string }[];
  created.push(id);
  return id;
}

test('an admin creates a quiz with one question in a category, and the explanation comes back in the edit form', async ({
  page,
  request,
}, testInfo) => {
  const errors = watchErrors(page);
  const category = unique(testInfo, 'Kategorie');
  const quiz = unique(testInfo, 'Quiz');
  const question = `${unique(testInfo, 'Frage')}?`;
  const explanation = 'Diese Erklärung sieht nur, wer geantwortet hat.';
  const categoryId = await createCategory(request, category);

  await signInAsAdmin(page);

  // The category list links to the category's quiz list, which is empty.
  await page.goto('/admin/categories');
  await control(page, label('admin.categories.actions.quizzes', category)).click();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${categoryId}/?$`));
  await expect(heading(page, label('admin.quizzes.title', category))).toBeVisible();
  await expect(page.getByText(text('admin.quizzes.empty'), { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  // Create the quiz: the form passes axe, the quiz starts unpublished.
  await control(page, text('admin.quizzes.create')).click();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${categoryId}/quizzes/new/?$`));
  await expect(heading(page, text('admin.quizzes.form.createTitle'))).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await page.getByLabel(text('admin.quizzes.form.title'), { exact: true }).fill(quiz);
  await page
    .getByLabel(text('admin.quizzes.form.description'), { exact: true })
    .fill('Vom E2E-Test angelegt');
  await expect(toggle(page, text('admin.quizzes.form.published'))).not.toBeChecked();
  await page.getByRole('button', { name: text('admin.quizzes.form.save'), exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/categories/${categoryId}/?$`));
  await expect(page.getByText(quiz, { exact: true })).toBeVisible();
  await expect(control(page, label('admin.quizzes.actions.publish', quiz))).toBeVisible();

  // The quiz's edit form shows its values and passes axe.
  await control(page, label('admin.quizzes.actions.edit', quiz)).click();
  await expect(page).toHaveURL(/\/admin\/quizzes\/[0-9a-f-]{36}\/edit\/?$/);
  await expect(heading(page, text('admin.quizzes.form.editTitle'))).toBeVisible();
  await expect(page.getByLabel(text('admin.quizzes.form.title'), { exact: true })).toHaveValue(
    quiz,
  );
  await expectNoSeriousAxeViolations(page);
  await page.goBack();

  // The quiz's question list, empty at first.
  await control(page, label('admin.quizzes.actions.questions', quiz)).click();
  await expect(page).toHaveURL(/\/admin\/quizzes\/[0-9a-f-]{36}\/?$/);
  const quizUrl = page.url();
  await expect(heading(page, label('admin.questions.title', quiz))).toBeVisible();
  await expect(page.getByText(text('admin.questions.empty'), { exact: true })).toBeVisible();

  // Create the question with an explanation, as multiple choice.
  await control(page, text('admin.questions.create')).click();
  await expect(page).toHaveURL(
    new RegExp(`${escape(quizUrl.replace(/\/$/, ''))}/questions/new/?$`),
  );
  await expect(heading(page, text('admin.questions.form.createTitle'))).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await page.getByLabel(text('admin.questions.form.text'), { exact: true }).fill(question);
  await page
    .getByLabel(text('admin.questions.form.explanation'), { exact: true })
    .fill(explanation);
  const multiple = toggle(page, text('admin.questions.form.multipleCorrect'));
  await expect(multiple).not.toBeChecked();
  await multiple.click();
  await expect(multiple).toBeChecked();
  await page.getByRole('button', { name: text('admin.questions.form.save'), exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`^${escape(quizUrl.replace(/\/$/, ''))}/?$`));
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  await expect(page.getByText(explanation)).toHaveCount(0);

  // Reopen the question: the explanation comes back from the database.
  await control(page, label('admin.questions.actions.edit', question)).click();
  await expect(page).toHaveURL(/\/admin\/quizzes\/[0-9a-f-]{36}\/questions\/[0-9a-f-]{36}\/?$/);
  await expect(heading(page, text('admin.questions.form.editTitle'))).toBeVisible();
  await expect(page.getByLabel(text('admin.questions.form.text'), { exact: true })).toHaveValue(
    question,
  );
  await expect(
    page.getByLabel(text('admin.questions.form.explanation'), { exact: true }),
  ).toHaveValue(explanation);
  await expect(toggle(page, text('admin.questions.form.multipleCorrect'))).toBeChecked();
  await expectNoSeriousAxeViolations(page);

  // Also after a reload, so the value isn't just the form's cache.
  await page.reload();
  await expect(
    page.getByLabel(text('admin.questions.form.explanation'), { exact: true }),
  ).toHaveValue(explanation);

  expect(errors).toEqual([]);
});

test('the quiz and question forms reject a blank title or text with their message and pass axe', async ({
  page,
  request,
}, testInfo) => {
  const categoryId = await createCategory(request, unique(testInfo, 'Kategorie'));
  await signInAsAdmin(page);

  await page.goto(`/admin/categories/${categoryId}/quizzes/new`);
  await expect(heading(page, text('admin.quizzes.form.createTitle'))).toBeVisible();
  await page.getByLabel(text('admin.quizzes.form.title'), { exact: true }).fill('   ');
  await page.getByRole('button', { name: text('admin.quizzes.form.save'), exact: true }).click();
  await expect(
    page.getByText(text('admin.quizzes.form.errors.titleRequired'), { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${categoryId}/quizzes/new/?$`));
  await expectNoSeriousAxeViolations(page);

  // A quiz to put the question into, through the form.
  const quiz = unique(testInfo, 'Quiz');
  await page.getByLabel(text('admin.quizzes.form.title'), { exact: true }).fill(quiz);
  await page.getByRole('button', { name: text('admin.quizzes.form.save'), exact: true }).click();
  await control(page, label('admin.quizzes.actions.questions', quiz)).click();
  await control(page, text('admin.questions.create')).click();
  await expect(heading(page, text('admin.questions.form.createTitle'))).toBeVisible();

  await page.getByLabel(text('admin.questions.form.text'), { exact: true }).fill('\t');
  await page.getByRole('button', { name: text('admin.questions.form.save'), exact: true }).click();
  await expect(
    page.getByText(text('admin.questions.form.errors.textRequired'), { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/questions\/new\/?$/);
  await expectNoSeriousAxeViolations(page);
});
