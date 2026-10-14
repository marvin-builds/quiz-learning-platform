import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
  type TestInfo,
} from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';
import { enterTotpCode, SEED_ADMIN, seedAdminAccessToken } from './admin-auth';

// Image upload for questions (#83) against the local stack: the seed admin
// (admin@example.com / admin-password) writes a question in a quiz of its
// own, picks e2e/fixtures/fuchs.png through the web file input (which
// accepts exactly png, jpeg and webp), sees its preview, is refused a save
// without alt text, saves it with one, and finds the image with its alt text
// again in the edit form. Once the quiz is published, a learner (a fresh
// visitor, signed in anonymously) sees the image on the question, loaded,
// with the alt text as its accessible name. axe runs on the form with the
// preview, in its error state, on the edit form and on the learner's
// question. Runs once per project in playwright.config.ts (phone and
// desktop).
//
// Hygiene (the database and the bucket are shared by every spec): the test
// creates its own category and quiz through the API, with unique names and a
// unique alt text per project and run, never touches seed content or seed
// images, and afterwards removes the objects its rows name from the
// quiz-images bucket and then the category (its quizzes, questions and
// answers cascade), also when it failed half-way.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password';
const FIXTURE = path.join(__dirname, 'fixtures', 'fuchs.png');

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

const unique = (testInfo: TestInfo, what: string) =>
  `E2E ${what} ${testInfo.project.name} ${Date.now()}`;

const created: { categoryId: string; quizIds: string[] }[] = [];

// Removes the objects the test's questions and answers name, then the test's
// category (its quizzes, questions and answers cascade), also when the test
// failed half-way. Only names its own rows hold are removed, so no seed image
// is ever touched.
test.afterEach(async ({ request }) => {
  const entries = created.splice(0);
  if (entries.length === 0) return;
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const headers = await adminHeaders(request);
  for (const { categoryId, quizIds } of entries) {
    const paths: string[] = [];
    for (const quizId of quizIds) {
      const questions = await request.get(
        `${apiUrl}/rest/v1/questions?quiz_id=eq.${quizId}&select=id,image_path`,
        { headers },
      );
      expect(questions.ok(), await questions.text()).toBe(true);
      const rows = (await questions.json()) as { id: string; image_path: string | null }[];
      paths.push(...rows.flatMap((row) => (row.image_path ? [row.image_path] : [])));
      if (rows.length > 0) {
        const answers = await request.get(
          `${apiUrl}/rest/v1/answers?question_id=in.(${rows.map((row) => row.id).join(',')})&select=image_path`,
          { headers },
        );
        expect(answers.ok(), await answers.text()).toBe(true);
        const answerRows = (await answers.json()) as { image_path: string | null }[];
        paths.push(...answerRows.flatMap((row) => (row.image_path ? [row.image_path] : [])));
      }
    }
    if (paths.length > 0) {
      const removed = await request.delete(`${apiUrl}/storage/v1/object/quiz-images`, {
        headers,
        data: { prefixes: paths },
      });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
    const response = await request.delete(`${apiUrl}/rest/v1/categories?id=eq.${categoryId}`, {
      headers,
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
});

// A published category with an unpublished quiz, created as the admin
// through the API.
async function createQuiz(
  request: APIRequestContext,
  testInfo: TestInfo,
): Promise<{ quizId: string; quiz: string }> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const headers = { ...(await adminHeaders(request)), Prefer: 'return=representation' };
  const category = await request.post(`${apiUrl}/rest/v1/categories?select=id`, {
    headers,
    data: {
      name: unique(testInfo, 'Kategorie'),
      description: 'Angelegt vom E2E-Test',
      published: true,
    },
  });
  expect(category.ok(), await category.text()).toBe(true);
  const [{ id: categoryId }] = (await category.json()) as { id: string }[];
  const entry = { categoryId, quizIds: [] as string[] };
  created.push(entry);

  const quiz = unique(testInfo, 'Bilderquiz');
  const response = await request.post(`${apiUrl}/rest/v1/quizzes?select=id`, {
    headers,
    data: { category_id: categoryId, title: quiz, published: false },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const [{ id: quizId }] = (await response.json()) as { id: string }[];
  entry.quizIds.push(quizId);
  return { quizId, quiz };
}

async function publish(request: APIRequestContext, quizId: string) {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const response = await request.patch(`${apiUrl}/rest/v1/quizzes?id=eq.${quizId}`, {
    headers: await adminHeaders(request),
    data: { published: true },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

const button = (page: Page, key: string, values: Record<string, string | number> = {}) =>
  page.getByRole('button', { name: text(key, values), exact: true });

// The pick control: a button that opens the file chooser, or a labelled file
// input; either way it has the translated name.
const pickControl = (page: Page) =>
  button(page, 'admin.questions.form.image.pick')
    .or(page.getByLabel(text('admin.questions.form.image.pick'), { exact: true }))
    .first();

const toggle = (page: Page, name: string) =>
  page
    .getByRole('switch', { name, exact: true })
    .or(page.getByRole('checkbox', { name, exact: true }))
    .or(page.getByRole('radio', { name, exact: true }));

// react-native-web renders an image as an element with role img whose picture
// is a background, plus a hidden <img> with the same source; a plain <img>
// is its own element. Both match the role, so take the outermost (first).
const imageNamed = (page: Page, name: string) =>
  page.getByRole('img', { name, exact: true }).first();

// The width the browser decoded for the image.
const naturalWidthOf = (image: Locator) =>
  image.evaluate((element) => {
    const img = element instanceof HTMLImageElement ? element : element.querySelector('img');
    return img && img.complete ? img.naturalWidth : 0;
  });

async function expectLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => naturalWidthOf(image)).toBeGreaterThan(0);
  const box = await image.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);
}

async function newVisitor(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const { baseURL, viewport, locale } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport, locale });
  return context.newPage();
}

test('an admin adds an image with alt text to a question, and a learner sees it with that label', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const errors = watchErrors(page);
  const { quizId, quiz } = await createQuiz(request, testInfo);
  const question = `${unique(testInfo, 'Welches Tier')}?`;
  const alt = unique(testInfo, 'Ein orangefarbener Kreis auf grünem Grund');

  await signInAsAdmin(page);
  await page.goto(`/admin/quizzes/${quizId}/questions/new`);
  await expect(
    page.getByRole('heading', { name: text('admin.questions.form.createTitle'), exact: true }),
  ).toBeVisible();

  await page.getByLabel(text('admin.questions.form.text'), { exact: true }).fill(question);
  await page
    .getByLabel(text('admin.questions.form.answers.text', { number: 1 }), { exact: true })
    .fill('Fuchs');
  await page
    .getByLabel(text('admin.questions.form.answers.text', { number: 2 }), { exact: true })
    .fill('Dachs');
  await toggle(page, text('admin.questions.form.answers.correct', { number: 1 })).click();

  // The file input accepts exactly the bucket's three types.
  const chooser = page.waitForEvent('filechooser');
  await pickControl(page).click();
  const fileChooser = await chooser;
  const accept = await fileChooser.element().getAttribute('accept');
  expect(
    (accept ?? '')
      .split(',')
      .map((type) => type.trim())
      .sort(),
  ).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  await fileChooser.setFiles(FIXTURE);

  await expectLoaded(imageNamed(page, text('admin.questions.form.image.preview')));
  await expectNoSeriousAxeViolations(page);

  // Without an alt text the form refuses to save and says why.
  await button(page, 'admin.questions.form.save').click();
  await expect(
    page.getByText(text('admin.questions.form.errors.imageAltRequired'), { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/questions\/new\/?$/);
  await expectNoSeriousAxeViolations(page);

  await page.getByLabel(text('admin.questions.form.image.alt'), { exact: true }).fill(alt);
  await button(page, 'admin.questions.form.save').click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${quizId}/?$`));
  await expect(page.getByText(question, { exact: true })).toBeVisible();

  // The edit form shows the stored image with its alt text.
  await button(page, 'admin.questions.actions.edit', { name: question })
    .or(page.getByRole('link', { name: text('admin.questions.actions.edit', { name: question }) }))
    .first()
    .click();
  await expectLoaded(imageNamed(page, text('admin.questions.form.image.preview')));
  await expect(
    page.getByLabel(text('admin.questions.form.image.alt'), { exact: true }),
  ).toHaveValue(alt);
  await expectNoSeriousAxeViolations(page);

  await publish(request, quizId);

  // A learner plays it in a browser of their own and sees the image, named by its alt text.
  const learner = await newVisitor(browser, testInfo);
  const learnerErrors = watchErrors(learner);
  try {
    await learner.goto(`/quizzes/${quizId}`);
    await expect(learner.getByText(quiz).first()).toBeVisible();
    await learner.getByRole('button', { name: text('quiz.start'), exact: true }).click();
    await expect(learner.getByText(question, { exact: true })).toBeVisible();
    await expectLoaded(imageNamed(learner, alt));
    await expectNoSeriousAxeViolations(learner);
    expect(learnerErrors).toEqual([]);
  } finally {
    await learner.context().close();
  }

  expect(errors).toEqual([]);
});
