import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { expectCspWithoutViolations, watchCsp } from './csp';

// E2E flow B (#84) against the local stack, at both sizes (the phone and
// desktop projects of playwright.config.ts):
//
// 1. The seed admin (admin@example.com / admin-password) signs in, creates a
//    category and a quiz in it, adds a question with an image (alt text
//    included), publishes the quiz and the category, and previews the quiz
//    (marked as a preview, with the correct answer and the explanation). A
//    learner (a fresh visitor, signed in anonymously by the app) then finds
//    the category, plays the quiz and sees the image and the result. axe
//    runs on every admin screen the admin visits, the sign-in screen and
//    the preview included.
// 2. A learner trying `/admin` routes is turned away: a fresh visitor and an
//    anonymous user to the sign-in screen, a registered learner (created by
//    the test, never in seed.sql) to "no access"; the preview of an
//    unpublished quiz shows them nothing of it. A learner's direct API
//    writes are rejected: an update and an insert on a content table, a
//    reorder call, the preview's solution reads, and an upload to the
//    quiz-images bucket; the rows and the bucket stay as they were.
// 3. The admin reorders categories, quizzes, questions and answers with the
//    move buttons, by keyboard only (Tab focus, Enter and Space); focus
//    stays on the pressed button of the moved item, and the first item's
//    "up" is disabled. A learner in a fresh browser (a fresh load) then sees
//    the new order on the home screen, the category screen and in the
//    player.
//
// Hygiene (the database and the bucket are shared by every spec, and the two
// projects may run at the same time): every name is unique per project and
// run, no assertion depends on how many other categories exist or where
// they are, seed content is never touched, and afterwards the test removes
// the objects its rows name from the bucket and then its categories (their
// quizzes, questions and answers cascade), also when it failed half-way.
// Registered learners it creates stay behind (no API role may delete
// users); they have no admin role and no content.

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

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const apiUrl = () => setting('EXPO_PUBLIC_SUPABASE_URL');
const apiKey = () => setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');

// Console errors and uncaught exceptions. `refusedRpc` names the one
// function whose refused calls (HTTP 400, which Chromium logs as "Failed to
// load resource") are expected and left out; every other error counts.
function watchErrors(page: Page, refusedRpc?: string): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (
      refusedRpc &&
      /status of 400\b/.test(message.text()) &&
      message.location().url.includes(`/rest/v1/rpc/${refusedRpc}`)
    ) {
      return;
    }
    errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const unique = (testInfo: TestInfo, what: string) =>
  `E2E ${what} ${testInfo.project.name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

// API sessions -----------------------------------------------------------------

type Headers = Record<string, string>;

async function tokenHeaders(token: string): Promise<Headers> {
  return { apikey: apiKey(), Authorization: `Bearer ${token}` };
}

// The admin's API headers. One password sign-in per worker (each worker
// loads this module once), reused by every helper and test after it: the
// stack allows 30 sign-ins per 5 minutes per IP ([auth.rate_limit] in
// supabase/config.toml), and both projects share it. The token outlives a
// run; nothing here signs this session out.
let adminSession: Headers | undefined;

async function adminHeaders(request: APIRequestContext): Promise<Headers> {
  if (adminSession) return adminSession;
  // Re-spec (#122): admin rights need an aal2 session (password and TOTP).
  const token = await seedAdminAccessToken(request);
  adminSession = await tokenHeaders(token);
  return adminSession;
}

// An anonymous user's API headers, as supabase-js gets them on Start.
async function anonymousHeaders(request: APIRequestContext): Promise<Headers> {
  const signUp = await request.post(`${apiUrl()}/auth/v1/signup`, {
    headers: { apikey: apiKey() },
    data: {},
  });
  expect(signUp.ok(), await signUp.text()).toBe(true);
  const { access_token: token } = (await signUp.json()) as { access_token: string };
  return tokenHeaders(token);
}

// A registered learner, created by the test: email and password, and the
// API headers of their session.
async function registeredLearner(
  request: APIRequestContext,
  testInfo: TestInfo,
): Promise<{ email: string; password: string; headers: Headers }> {
  const email = `e2e-learner-${testInfo.project.name}-${Date.now()}${Math.floor(
    Math.random() * 1000,
  )}@example.test`;
  const password = 'learner-password-e2e';
  const signUp = await request.post(`${apiUrl()}/auth/v1/signup`, {
    headers: { apikey: apiKey() },
    data: { email, password },
  });
  expect(signUp.ok(), await signUp.text()).toBe(true);
  const { access_token: token } = (await signUp.json()) as { access_token: string };
  return { email, password, headers: await tokenHeaders(token) };
}

// Fixtures through the API, as the admin -------------------------------------

const createdCategories: string[] = [];

async function createCategory(
  request: APIRequestContext,
  name: string,
  published: boolean,
): Promise<string> {
  const response = await request.post(`${apiUrl()}/rest/v1/categories?select=id`, {
    headers: { ...(await adminHeaders(request)), Prefer: 'return=representation' },
    data: { name, description: 'Angelegt vom E2E-Test (Flow B)', published },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const [{ id }] = (await response.json()) as { id: string }[];
  createdCategories.push(id);
  return id;
}

async function createQuiz(
  request: APIRequestContext,
  categoryId: string,
  title: string,
): Promise<string> {
  const response = await request.post(`${apiUrl()}/rest/v1/quizzes?select=id`, {
    headers: { ...(await adminHeaders(request)), Prefer: 'return=representation' },
    data: { category_id: categoryId, title, published: false },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const [{ id }] = (await response.json()) as { id: string }[];
  return id;
}

// A single choice question; the first answer is the correct one.
async function createQuestion(
  request: APIRequestContext,
  quizId: string,
  questionText: string,
  answers: string[],
): Promise<string> {
  const response = await request.post(`${apiUrl()}/rest/v1/rpc/save_question`, {
    headers: await adminHeaders(request),
    data: {
      quiz_id: quizId,
      question_id: null,
      text: questionText,
      explanation: null,
      multiple_correct: false,
      answers: answers.map((answer, index) => ({ text: answer, is_correct: index === 0 })),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as string;
}

// Every category's name in the server's order, as the admin sees them.
async function categoryNamesInOrder(request: APIRequestContext): Promise<string[]> {
  const response = await request.get(
    `${apiUrl()}/rest/v1/categories?select=name&order=sort_order.asc,id.asc`,
    { headers: await adminHeaders(request) },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { name: string }[]).map((row) => row.name);
}

async function publishQuiz(request: APIRequestContext, quizId: string) {
  const response = await request.patch(`${apiUrl()}/rest/v1/quizzes?id=eq.${quizId}`, {
    headers: await adminHeaders(request),
    data: { published: true },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

// Removes the objects the test's rows name, then the test's categories (their
// quizzes, questions and answers cascade), also when the test failed
// half-way. Only names its own rows hold are removed.
test.afterEach(async ({ request }) => {
  const categoryIds = createdCategories.splice(0);
  if (categoryIds.length === 0) return;
  const headers = await adminHeaders(request);
  for (const categoryId of categoryIds) {
    const quizzes = await request.get(
      `${apiUrl()}/rest/v1/quizzes?category_id=eq.${categoryId}&select=id`,
      { headers },
    );
    expect(quizzes.ok(), await quizzes.text()).toBe(true);
    const quizIds = ((await quizzes.json()) as { id: string }[]).map((row) => row.id);
    const paths: string[] = [];
    if (quizIds.length > 0) {
      const questions = await request.get(
        `${apiUrl()}/rest/v1/questions?quiz_id=in.(${quizIds.join(',')})&select=id,image_path`,
        { headers },
      );
      expect(questions.ok(), await questions.text()).toBe(true);
      const rows = (await questions.json()) as { id: string; image_path: string | null }[];
      paths.push(...rows.flatMap((row) => (row.image_path ? [row.image_path] : [])));
      if (rows.length > 0) {
        const answers = await request.get(
          `${apiUrl()}/rest/v1/answers?question_id=in.(${rows.map((row) => row.id).join(',')})&select=image_path`,
          { headers },
        );
        expect(answers.ok(), await answers.text()).toBe(true);
        const answerRows = (await answers.json()) as { image_path: string | null }[];
        paths.push(...answerRows.flatMap((row) => (row.image_path ? [row.image_path] : [])));
      }
    }
    if (paths.length > 0) {
      const removed = await request.delete(`${apiUrl()}/storage/v1/object/quiz-images`, {
        headers,
        data: { prefixes: paths },
      });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
    const response = await request.delete(`${apiUrl()}/rest/v1/categories?id=eq.${categoryId}`, {
      headers,
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
});

// Page helpers -------------------------------------------------------------------

const button = (page: Page, key: string, values: Record<string, string | number> = {}) =>
  page.getByRole('button', { name: text(key, values), exact: true });

const link = (page: Page, key: string, values: Record<string, string | number> = {}) =>
  page.getByRole('link', { name: text(key, values), exact: true });

const toggle = (page: Page, name: string) =>
  page
    .getByRole('switch', { name, exact: true })
    .or(page.getByRole('checkbox', { name, exact: true }))
    .or(page.getByRole('radio', { name, exact: true }));

const pickControl = (page: Page) =>
  button(page, 'admin.questions.form.image.pick')
    .or(page.getByLabel(text('admin.questions.form.image.pick'), { exact: true }))
    .first();

const imageNamed = (page: Page, name: string) =>
  page.getByRole('img', { name, exact: true }).first();

async function expectLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const img = element instanceof HTMLImageElement ? element : element.querySelector('img');
        return img && img.complete ? img.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);
}

// An answer's radio or checkbox in the player; its name may carry a mark.
const option = (page: Page, role: 'radio' | 'checkbox', answer: string) =>
  page.getByRole(role, {
    name: new RegExp(`^${escape(answer)}(?!\\w)|(?<!\\w)${escape(answer)}$`),
  });

async function newVisitor(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const { baseURL, viewport, locale } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport, locale });
  return context.newPage();
}

async function signInAs(page: Page, email: string, password: string) {
  await page.goto('/admin/sign-in');
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(email);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(password);
  await button(page, 'admin.signIn.submit').click();
}

// The vertical position of the first visible element with exactly this text.
async function topOf(page: Page, name: string): Promise<number> {
  const element = page.getByText(name, { exact: true }).filter({ visible: true }).first();
  await expect(element).toBeVisible();
  const box = await element.boundingBox();
  if (!box) throw new Error(`${name} has no box`);
  return box.y;
}

// The names in the order they appear on the page, top to bottom.
async function orderOf(page: Page, names: string[]): Promise<string[]> {
  const tops = await Promise.all(
    names.map(async (name) => [name, await topOf(page, name)] as const),
  );
  return [...tops].sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

// Presses a control by keyboard: it is in the tab order (enabled, no
// tabindex -1), so Tab reaches it; focus it, then the key.
async function pressByKeyboard(control: Locator, key: 'Enter' | ' ') {
  await expect(control).toBeEnabled();
  await expect(control).not.toHaveAttribute('tabindex', '-1');
  await control.focus();
  await expect(control).toBeFocused();
  await control.press(key === ' ' ? 'Space' : 'Enter');
}

// Re-spec (#84, N3): the category list is global, and a reorder from a list
// with the same members is accepted (last write wins), so the phone and
// desktop projects, which run in separate worker processes, could revert
// each other's category move. This exclusive lock file (created with 'wx')
// serializes that step across processes. A holder whose process is gone
// leaves a stale lock, which is taken over; the wait is bounded.
const CATEGORY_LOCK = path.join(__dirname, '..', 'test-results', 'category-reorder.lock');

async function acquireCategoryLock(): Promise<() => void> {
  mkdirSync(path.dirname(CATEGORY_LOCK), { recursive: true });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      writeFileSync(CATEGORY_LOCK, String(process.pid), { flag: 'wx' });
      return () => {
        if (readLockHolder() === process.pid) rmSync(CATEGORY_LOCK, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readLockHolder();
    if (holder !== null && !isAlive(holder)) {
      rmSync(CATEGORY_LOCK, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`category lock still held by pid ${holder}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readLockHolder(): number | null {
  try {
    const pid = Number(readFileSync(CATEGORY_LOCK, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// 1. Flow B --------------------------------------------------------------------------

test('flow B: an admin creates, publishes and previews a quiz with an image, and a learner plays it; axe passes on every admin screen', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const errors = watchErrors(page);
  // #123: the admin flow, the blob: preview of the picked image and the
  // Storage images run under the deployed CSP without a violation.
  const csp = await watchCsp(page);
  const category = unique(testInfo, 'Kategorie');
  const quiz = unique(testInfo, 'Quiz');
  const question = `${unique(testInfo, 'Welches Tier')}?`;
  const alt = unique(testInfo, 'Ein orangefarbener Kreis');
  const explanation = 'Der Fuchs hat ein rotes Fell.';

  // Sign-in screen, then the category list. Re-spec (#116): the dashboard
  // is gone; the sign-in lands on the list, which passes axe as before.
  await page.goto('/admin/sign-in');
  await expect(page.getByLabel(text('admin.signIn.email'), { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await signInAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);

  // The category: list, create form, back on the list.
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(
    page.getByRole('heading', { name: text('admin.categories.title'), exact: true }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await link(page, 'admin.categories.create').click();
  await expect(page).toHaveURL(/\/admin\/categories\/new\/?$/);
  await expectNoSeriousAxeViolations(page);
  await page.getByLabel(text('admin.categories.form.name'), { exact: true }).fill(category);
  await button(page, 'admin.categories.form.save').click();
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(page.getByText(category, { exact: true })).toBeVisible();
  // Recorded for cleanup right away, by its unique name, so a failure
  // further on still removes it.
  const saved = await request.get(
    `${apiUrl()}/rest/v1/categories?name=eq.${encodeURIComponent(category)}&select=id`,
    { headers: await adminHeaders(request) },
  );
  expect(saved.ok(), await saved.text()).toBe(true);
  const savedIds = ((await saved.json()) as { id: string }[]).map((row) => row.id);
  createdCategories.push(...savedIds);
  expect(savedIds).toHaveLength(1);

  // The quiz: the category's list, create form, back on the list.
  await link(page, 'admin.categories.actions.quizzes', { name: category }).click();
  await expect(page).toHaveURL(/\/admin\/categories\/[0-9a-f-]{36}\/?$/);
  const categoryId = /\/admin\/categories\/([0-9a-f-]{36})/.exec(page.url())![1];
  expect(categoryId).toBe(savedIds[0]);
  await expectNoSeriousAxeViolations(page);
  await link(page, 'admin.quizzes.create').click();
  await expect(page).toHaveURL(/\/quizzes\/new\/?$/);
  await expect(page.getByLabel(text('admin.quizzes.form.title'), { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await page.getByLabel(text('admin.quizzes.form.title'), { exact: true }).fill(quiz);
  await button(page, 'admin.quizzes.form.save').click();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${categoryId}/?$`));
  await expect(page.getByText(quiz, { exact: true })).toBeVisible();

  // The question with an image: the quiz's questions, the create form.
  await link(page, 'admin.quizzes.actions.questions', { name: quiz }).click();
  await expect(page).toHaveURL(/\/admin\/quizzes\/[0-9a-f-]{36}\/?$/);
  const quizId = /\/admin\/quizzes\/([0-9a-f-]{36})/.exec(page.url())![1];
  await expectNoSeriousAxeViolations(page);
  await link(page, 'admin.questions.create').click();
  await expect(page).toHaveURL(/\/questions\/new\/?$/);
  await page.getByLabel(text('admin.questions.form.text'), { exact: true }).fill(question);
  await page
    .getByLabel(text('admin.questions.form.explanation'), { exact: true })
    .fill(explanation);
  await page
    .getByLabel(text('admin.questions.form.answers.text', { number: 1 }), { exact: true })
    .fill('Fuchs');
  await page
    .getByLabel(text('admin.questions.form.answers.text', { number: 2 }), { exact: true })
    .fill('Dachs');
  await toggle(page, text('admin.questions.form.answers.correct', { number: 1 })).click();
  const chooser = page.waitForEvent('filechooser');
  await pickControl(page).click();
  await (await chooser).setFiles(FIXTURE);
  await expectLoaded(imageNamed(page, text('admin.questions.form.image.preview')));
  await page.getByLabel(text('admin.questions.form.image.alt'), { exact: true }).fill(alt);
  await expectNoSeriousAxeViolations(page);
  await button(page, 'admin.questions.form.save').click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${quizId}/?$`));
  await expect(page.getByText(question, { exact: true })).toBeVisible();

  // The preview from the quiz editor, before anything is published.
  await link(page, 'admin.questions.preview', { name: quiz }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${quizId}/preview/?$`));
  await expect(page.getByText(text('admin.preview.marker'), { exact: true }).first()).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  await expect(
    page.getByText(text('admin.preview.correctAnswer', { answer: 'Fuchs' }), { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(explanation, { exact: true })).toBeVisible();
  await expectLoaded(imageNamed(page, alt));
  await expectNoSeriousAxeViolations(page);

  // Publish the quiz, then the category, on their lists.
  await page.goto(`/admin/categories/${categoryId}`);
  await button(page, 'admin.quizzes.actions.publish', { name: quiz }).click();
  await expect(button(page, 'admin.quizzes.actions.unpublish', { name: quiz })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await page.goto('/admin/categories');
  await button(page, 'admin.categories.actions.publish', { name: category }).click();
  await expect(
    button(page, 'admin.categories.actions.unpublish', { name: category }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  // A learner finds and plays it in a browser of their own.
  const learner = await newVisitor(browser, testInfo);
  const learnerErrors = watchErrors(learner);
  const learnerCsp = await watchCsp(learner);
  try {
    await learner.goto('/');
    await learner.getByRole('link', { name: new RegExp(escape(category)) }).click();
    await learner.getByRole('link', { name: new RegExp(escape(quiz)) }).click();
    await expect(learner).toHaveURL(new RegExp(`/quizzes/${quizId}/?$`));
    await button(learner, 'quiz.start').click();
    await expect(learner.getByText(question, { exact: true })).toBeVisible();
    await expectLoaded(imageNamed(learner, alt));
    await option(learner, 'radio', 'Fuchs').click();
    await button(learner, 'quiz.submit').click();
    await expect(learner.getByText(text('quiz.feedback.correct'), { exact: true })).toBeVisible();
    await expect(learner.getByText(explanation, { exact: true })).toBeVisible();
    await button(learner, 'quiz.seeResult').click();
    await expect(learner.getByText(text('quiz.result.title'), { exact: true })).toBeVisible();
    // The learner never saw a preview marker.
    await expect(learner.getByText(text('admin.preview.marker'), { exact: true })).toHaveCount(0);
    expect(learnerErrors).toEqual([]);
    await expectCspWithoutViolations(learnerCsp);
  } finally {
    await learner.context().close();
  }

  expect(errors).toEqual([]);
  await expectCspWithoutViolations(csp);
});

// 2. Learners are turned away ---------------------------------------------------------

test('a learner is turned away from /admin routes and the preview, and their direct API writes are rejected', async ({
  browser,
  request,
}, testInfo) => {
  const categoryName = unique(testInfo, 'Verbotene Kategorie');
  const categoryId = await createCategory(request, categoryName, true);
  const draft = unique(testInfo, 'Unveröffentlichtes Quiz');
  const draftId = await createQuiz(request, categoryId, draft);
  const draftQuestion = `${unique(testInfo, 'Geheime Frage')}?`;
  const draftQuestionId = await createQuestion(request, draftId, draftQuestion, ['Ja', 'Nein']);

  // A fresh visitor, then an anonymous user (after starting a published quiz).
  const visitor = await newVisitor(browser, testInfo);
  try {
    for (const url of ['/admin', '/admin/categories', `/admin/quizzes/${draftId}/preview`]) {
      await visitor.goto(url);
      await expect(visitor).toHaveURL(/\/admin\/sign-in\/?$/);
      await expect(visitor.getByText(draft)).toHaveCount(0);
      await expect(visitor.getByText(draftQuestion)).toHaveCount(0);
    }
    await expectNoSeriousAxeViolations(visitor);

    await visitor.goto('/');
    await visitor.getByRole('link', { name: /Geografie/ }).click();
    await visitor.getByRole('link', { name: /Hauptstädte Europas/ }).click();
    await button(visitor, 'quiz.start').click();
    await expect(visitor.getByText('Was ist die Hauptstadt von Frankreich?')).toBeVisible();
    for (const url of [
      '/admin',
      `/admin/categories/${categoryId}`,
      `/admin/quizzes/${draftId}/preview`,
    ]) {
      await visitor.goto(url);
      await expect(visitor).toHaveURL(/\/admin\/sign-in\/?$/);
      await expect(visitor.getByText(draft)).toHaveCount(0);
      await expect(visitor.getByText(draftQuestion)).toHaveCount(0);
    }
  } finally {
    await visitor.context().close();
  }

  // A registered learner signs in and gets "no access", also on the preview.
  const learnerAccount = await registeredLearner(request, testInfo);
  const learner = await newVisitor(browser, testInfo);
  try {
    await signInAs(learner, learnerAccount.email, learnerAccount.password);
    await expect(learner.getByText(text('admin.guard.noAccess'), { exact: true })).toBeVisible();
    await learner.goto(`/admin/quizzes/${draftId}/preview`);
    await expect(learner.getByText(text('admin.guard.noAccess'), { exact: true })).toBeVisible();
    await expect(learner.getByText(draft)).toHaveCount(0);
    await expect(learner.getByText(draftQuestion)).toHaveCount(0);
    await expect(learner.getByText(text('admin.preview.marker'), { exact: true })).toHaveCount(0);
    await expectNoSeriousAxeViolations(learner);
  } finally {
    await learner.context().close();
  }

  // Direct API writes, by an anonymous user and by the registered learner.
  const admin = await adminHeaders(request);
  const before = await request.get(
    `${apiUrl()}/rest/v1/categories?id=eq.${categoryId}&select=name,sort_order`,
    { headers: admin },
  );
  expect(before.ok()).toBe(true);
  const [stored] = (await before.json()) as { name: string; sort_order: number }[];

  for (const [who, headers] of [
    ['anonymous user', await anonymousHeaders(request)],
    ['registered learner', learnerAccount.headers],
  ] as const) {
    const update = await request.patch(`${apiUrl()}/rest/v1/categories?id=eq.${categoryId}`, {
      headers: { ...headers, Prefer: 'return=representation' },
      data: { name: 'Gekapert' },
    });
    // RLS lets the update touch no row (or the grant refuses it).
    expect(
      !update.ok() || ((await update.json()) as unknown[]).length === 0,
      `${who}: update`,
    ).toBe(true);

    const insert = await request.post(`${apiUrl()}/rest/v1/quizzes`, {
      headers,
      data: { category_id: categoryId, title: 'Eingeschmuggelt', published: true },
    });
    expect(insert.ok(), `${who}: insert`).toBe(false);

    const sortOrder = await request.patch(`${apiUrl()}/rest/v1/categories?id=eq.${categoryId}`, {
      headers,
      data: { sort_order: 1 },
    });
    expect(sortOrder.ok(), `${who}: direct sort_order write`).toBe(false);

    const reorder = await request.post(`${apiUrl()}/rest/v1/rpc/reorder_quizzes`, {
      headers,
      data: { category_id: categoryId, quiz_ids: [draftId] },
    });
    expect(reorder.status(), `${who}: reorder`).toBe(400);
    expect(((await reorder.json()) as { message: string }).message, `${who}: reorder`).toBe(
      'not available',
    );

    for (const fn of ['admin_question', 'admin_answers']) {
      const read = await request.post(`${apiUrl()}/rest/v1/rpc/${fn}`, {
        headers,
        data: { question_id: draftQuestionId },
      });
      expect(read.ok(), `${who}: ${fn}`).toBe(false);
      expect(await read.text(), `${who}: ${fn}`).not.toContain('Ja');
    }

    const objectName = `${crypto.randomUUID()}.png`;
    const upload = await request.post(`${apiUrl()}/storage/v1/object/quiz-images/${objectName}`, {
      headers: { ...headers, 'Content-Type': 'image/png' },
      data: readFileSync(FIXTURE),
    });
    expect(upload.ok(), `${who}: upload`).toBe(false);
    const fetched = await request.get(
      `${apiUrl()}/storage/v1/object/public/quiz-images/${objectName}`,
    );
    expect(fetched.ok(), `${who}: the refused object doesn't exist`).toBe(false);
  }

  const after = await request.get(
    `${apiUrl()}/rest/v1/categories?id=eq.${categoryId}&select=name,sort_order`,
    { headers: admin },
  );
  expect((await after.json()) as unknown[]).toEqual([stored]);
  const quizzes = await request.get(
    `${apiUrl()}/rest/v1/quizzes?category_id=eq.${categoryId}&select=id`,
    { headers: admin },
  );
  expect(((await quizzes.json()) as { id: string }[]).map((row) => row.id)).toEqual([draftId]);
});

// 3. Reordering by keyboard, seen by a learner after a fresh load ---------------------

test('an admin reorders categories, quizzes, questions and answers by keyboard, and a learner sees the new order after a reload', async ({
  page,
  browser,
  request,
}, testInfo) => {
  // Other specs and the other project write categories at the same time, which
  // makes a reorder_categories call stale; the database refuses it (400).
  const errors = watchErrors(page, 'reorder_categories');
  // Two categories, the second created last, so it starts below the first.
  const first = unique(testInfo, 'Erste Kategorie');
  const second = unique(testInfo, 'Zweite Kategorie');
  const firstId = await createCategory(request, first, true);
  await createCategory(request, second, true);

  // Three quizzes in the first category; the first with three questions.
  const quizNames = [1, 2, 3].map((n) => unique(testInfo, `Quiz ${n}`));
  const quizIds: string[] = [];
  for (const name of quizNames) quizIds.push(await createQuiz(request, firstId, name));
  const questions = [1, 2, 3].map((n) => `${unique(testInfo, `Frage ${n}`)}?`);
  const answersOfFirst = ['Eins', 'Zwei', 'Drei'];
  await createQuestion(request, quizIds[0], questions[0], answersOfFirst);
  await createQuestion(request, quizIds[0], questions[1], ['Ja', 'Nein']);
  await createQuestion(request, quizIds[0], questions[2], ['Ja', 'Nein']);
  await createQuestion(request, quizIds[1], `${unique(testInfo, 'Füllfrage')}?`, ['Ja', 'Nein']);
  await createQuestion(request, quizIds[2], `${unique(testInfo, 'Füllfrage')}?`, ['Ja', 'Nein']);
  for (const id of quizIds) await publishQuiz(request, id);

  await signInAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  // Re-spec (#116): the sign-in lands on the category list, not the dashboard.
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);

  // Re-spec (#84, N3): hold the category lock from loading the category
  // list through the learner's check of the category order, so no other
  // project's category reorder can interleave and revert this one. The
  // learner's browser opens first, so its clean-up wraps the lock.
  const learner = await newVisitor(browser, testInfo);
  try {
    const releaseCategoryLock = await acquireCategoryLock();
    try {
      // Categories: move the second up until it is above the first. Other runs
      // may have put categories in between, so it may take more than one move.
      // A concurrent writer can make a move stale: the database refuses it, the
      // translated error shows, and the test reloads and presses again. Each
      // move waits until the list shows the second above its old neighbour.
      await page.goto('/admin/categories');
      const moveSecondUp = button(page, 'admin.categories.actions.moveUp', { name: second });
      const refused = page.getByText(text('admin.categories.errors.reorder'), { exact: true });
      //
      // Re-spec (#84, N3): the other project reorders the same global list at the
      // same time, and a reorder from a list with the same members is accepted
      // (last write wins), so its write can put the second back where it was.
      // Once this press's reorder_categories call has answered, "neither moved
      // nor refused" (the database has the old neighbour above the second again)
      // counts like a refusal: reload and press again, within the same 10 tries.
      let outcome = 'pending';
      for (let attempts = 0; attempts < 10; attempts += 1) {
        if (outcome === 'reverted' || (await refused.count()) > 0) await page.reload();
        const [top] = await orderOf(page, [first, second]);
        if (top === second) break;
        const names = await categoryNamesInOrder(request);
        const above = names[names.indexOf(second) - 1];
        let answered = false;
        page
          .waitForResponse((response) => response.url().includes('/rest/v1/rpc/reorder_categories'))
          .then(
            () => (answered = true),
            () => undefined,
          );
        await pressByKeyboard(moveSecondUp, 'Enter');
        outcome = 'pending';
        await expect
          .poll(async () => {
            if ((await refused.count()) > 0) outcome = 'refused';
            else if ((await orderOf(page, [above, second]))[0] === second) outcome = 'moved';
            else if (answered) {
              const now = await categoryNamesInOrder(request);
              if (now.indexOf(above) < now.indexOf(second)) outcome = 'reverted';
            }
            return outcome;
          })
          .not.toBe('pending');
        if (outcome === 'moved') await expect(moveSecondUp).toBeFocused();
      }
      expect(await orderOf(page, [first, second])).toEqual([second, first]);
      await expect(refused).toHaveCount(0);
      await expectNoSeriousAxeViolations(page);

      // Quizzes: the third moves up one, with Space; focus stays on its button.
      await page.goto(`/admin/categories/${firstId}`);
      await expect(
        button(page, 'admin.quizzes.actions.moveUp', { name: quizNames[0] }),
      ).toBeDisabled();
      await expect(
        button(page, 'admin.quizzes.actions.moveDown', { name: quizNames[2] }),
      ).toBeDisabled();
      const moveThirdQuizUp = button(page, 'admin.quizzes.actions.moveUp', { name: quizNames[2] });
      await pressByKeyboard(moveThirdQuizUp, ' ');
      await expect
        .poll(() => orderOf(page, quizNames))
        .toEqual([quizNames[0], quizNames[2], quizNames[1]]);
      await expect(moveThirdQuizUp).toBeFocused();
      await expect(
        button(page, 'admin.quizzes.actions.moveDown', { name: quizNames[1] }),
      ).toBeDisabled();
      await expectNoSeriousAxeViolations(page);

      // Questions: the third moves up one, with Enter.
      await page.goto(`/admin/quizzes/${quizIds[0]}`);
      const moveThirdQuestionUp = button(page, 'admin.questions.actions.moveUp', {
        name: questions[2],
      });
      await pressByKeyboard(moveThirdQuestionUp, 'Enter');
      await expect
        .poll(() => orderOf(page, questions))
        .toEqual([questions[0], questions[2], questions[1]]);
      await expect(moveThirdQuestionUp).toBeFocused();
      await expectNoSeriousAxeViolations(page);

      // Answers: in the first question's form, the third answer moves up one;
      // focus stays on its button, now named with its new number; then save.
      await link(page, 'admin.questions.actions.edit', { name: questions[0] }).click();
      await expect(
        page.getByLabel(text('admin.questions.form.answers.text', { number: 3 }), { exact: true }),
      ).toHaveValue('Drei');
      await pressByKeyboard(
        button(page, 'admin.questions.form.answers.moveUp', { number: 3 }),
        'Enter',
      );
      await expect(
        page.getByLabel(text('admin.questions.form.answers.text', { number: 2 }), { exact: true }),
      ).toHaveValue('Drei');
      await expect(
        button(page, 'admin.questions.form.answers.moveUp', { number: 2 }),
      ).toBeFocused();
      await expect(
        button(page, 'admin.questions.form.answers.moveUp', { number: 1 }),
      ).toBeDisabled();
      await expectNoSeriousAxeViolations(page);
      await button(page, 'admin.questions.form.save').click();
      await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${quizIds[0]}/?$`));

      // No drag interaction anywhere on the lists: nothing is draggable.
      await page.goto(`/admin/categories/${firstId}`);
      await expect(page.locator('[draggable="true"]')).toHaveCount(0);

      // A learner in a fresh browser sees the new order everywhere.
      await learner.goto('/');
      expect(await orderOf(learner, [first, second])).toEqual([second, first]);
    } finally {
      releaseCategoryLock();
    }

    await learner.getByRole('link', { name: new RegExp(escape(first)) }).click();
    await expect
      .poll(() => orderOf(learner, quizNames))
      .toEqual([quizNames[0], quizNames[2], quizNames[1]]);

    await learner.getByRole('link', { name: new RegExp(escape(quizNames[0])) }).click();
    await button(learner, 'quiz.start').click();
    await expect(learner.getByText(questions[0], { exact: true })).toBeVisible();
    expect(await orderOf(learner, answersOfFirst)).toEqual(['Eins', 'Drei', 'Zwei']);
    await option(learner, 'radio', 'Eins').click();
    await button(learner, 'quiz.submit').click();
    await button(learner, 'quiz.next').click();
    await expect(learner.getByText(questions[2], { exact: true })).toBeVisible();
    await option(learner, 'radio', 'Ja').click();
    await button(learner, 'quiz.submit').click();
    await button(learner, 'quiz.next').click();
    await expect(learner.getByText(questions[1], { exact: true })).toBeVisible();
  } finally {
    await learner.context().close();
  }

  expect(errors).toEqual([]);
});
