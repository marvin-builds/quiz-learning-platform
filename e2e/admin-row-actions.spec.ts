import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type APIRequestContext, expect, type Page, test, type TestInfo } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';
import { enterTotpCode, SEED_ADMIN, seedAdminAccessToken } from './admin-auth';

// Issue #117, short action labels in the admin lists, against the local
// stack, once per project in playwright.config.ts (phone 390 px and desktop
// 1280 px, German): in the category list, a category's quiz list, a quiz's
// question list and the question form's answers, a row with a long name
// shows its actions with the short labels ("Quizze", "Bearbeiten", "↑ Nach
// oben", …), each found by its full accessible name "<label>: <row>"; no
// action's label breaks onto a second line (the row's actions may flow onto
// several lines), nothing reaches past the screen's width, and axe passes on
// each of those screens. Delete ("Löschen", "Entfernen") stays visually
// distinct from the row's other buttons (the issue's Design: red).
//
// axe's default rules don't include label-content-name-mismatch, so "the
// name starts with the visible label" is proven in Jest
// (src/__tests__/admin-row-actions.test.tsx), not here.
//
// Like admin-quizzes.spec.ts, this spec never touches seed content: it
// creates its own unpublished category through the API as the admin and
// deletes it afterwards (its quiz and question go with it).

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

async function signInAsAdmin(page: Page) {
  await page.goto('/admin/sign-in');
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
}

// The admin's API headers, as supabase-js sends them after signing in.
async function adminHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const key = setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  // Re-spec (#122): admin rights need an aal2 session (password and TOTP).
  const token = await seedAdminAccessToken(request);
  return { apikey: key, Authorization: `Bearer ${token}` };
}

// Unique per project and run, so parallel projects and reruns don't collide.
const unique = (testInfo: TestInfo, what: string) =>
  `E2E ${what} ${testInfo.project.name} ${Date.now()}`;

const LONG_WORD = 'Donaudampfschifffahrtsgesellschaftskapitänsmützenhalterungsschrauben';

const created: string[] = [];

// Removes the test's category (its quiz and question cascade), also when a
// test failed half-way.
test.afterEach(async ({ request }) => {
  const ids = created.splice(0);
  if (ids.length === 0) return;
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const headers = await adminHeaders(request);
  for (const id of ids) {
    await request.delete(`${apiUrl}/rest/v1/categories?id=eq.${id}`, { headers });
  }
});

type Content = {
  category: { id: string; name: string };
  quiz: { id: string; title: string };
  question: { id: string; text: string };
};

// An unpublished category, a quiz and a question with two answers, every
// name long, created as the admin through the API.
async function createContent(request: APIRequestContext, testInfo: TestInfo): Promise<Content> {
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const headers = { ...(await adminHeaders(request)), Prefer: 'return=representation' };
  const name = `${unique(testInfo, 'Kategorie')} ${LONG_WORD} ${LONG_WORD}`;
  const categoryResponse = await request.post(`${apiUrl}/rest/v1/categories?select=id`, {
    headers,
    data: { name, description: 'Angelegt vom E2E-Test', published: false },
  });
  expect(categoryResponse.ok(), await categoryResponse.text()).toBe(true);
  const [{ id: categoryId }] = (await categoryResponse.json()) as { id: string }[];
  created.push(categoryId);

  const title = `${LONG_WORD} ${LONG_WORD} Quiz`;
  const quizResponse = await request.post(`${apiUrl}/rest/v1/quizzes?select=id`, {
    headers,
    data: { category_id: categoryId, title, published: false },
  });
  expect(quizResponse.ok(), await quizResponse.text()).toBe(true);
  const [{ id: quizId }] = (await quizResponse.json()) as { id: string }[];

  const questionText = `Was ist eine ${LONG_WORD} und wozu braucht man eine ${LONG_WORD}?`;
  const questionResponse = await request.post(`${apiUrl}/rest/v1/rpc/save_question`, {
    headers,
    data: {
      quiz_id: quizId,
      question_id: null,
      text: questionText,
      explanation: null,
      multiple_correct: false,
      answers: [
        { text: `Eine ${LONG_WORD}`, is_correct: true },
        { text: 'Nein', is_correct: false },
      ],
    },
  });
  expect(questionResponse.ok(), await questionResponse.text()).toBe(true);
  const questionId = (await questionResponse.json()) as string;

  return {
    category: { id: categoryId, name },
    quiz: { id: quizId, title },
    question: { id: questionId, text: questionText },
  };
}

type Action = { role: 'button' | 'link'; label: string };

// The visible label without the move buttons' decorative arrow: the part the
// accessible name starts with.
const spoken = (label: string) => label.replace(/^[↑↓]\s*/u, '');

// The visible label as a pattern: the move buttons' decorative arrow may be
// its own (aria-hidden) text, so the space after it is optional, just as the
// Jest tests join a control's texts with a space; the rest is exact.
function shownAs(label: string): RegExp {
  const arrow = /^([↑↓])\s*/u.exec(label);
  const rest = label.slice(arrow ? arrow[0].length : 0).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${arrow ? `${arrow[1]}\\s*` : ''}${rest}$`, 'u');
}

// A row's action by its full accessible name, "<label>: <row>", exactly, so
// "Bearbeiten: Geo" never matches "Bearbeiten: Geografie".
const action = (page: Page, row: string, { role, label }: Action) =>
  page.getByRole(role, { name: `${spoken(label)}: ${row}`, exact: true });

// The screens, each with the row whose actions are checked and those actions.
function screens(content: Content) {
  const move: Action[] = [
    { role: 'button', label: '↑ Nach oben' },
    { role: 'button', label: '↓ Nach unten' },
  ];
  return [
    {
      what: 'the category list',
      url: '/admin/categories',
      row: content.category.name,
      actions: [
        { role: 'link', label: 'Quizze' },
        { role: 'link', label: 'Bearbeiten' },
        { role: 'button', label: 'Veröffentlichen' },
        ...move,
        { role: 'button', label: 'Löschen' },
      ] as Action[],
    },
    {
      what: "the category's quiz list",
      url: `/admin/categories/${content.category.id}`,
      row: content.quiz.title,
      actions: [
        { role: 'link', label: 'Fragen' },
        { role: 'link', label: 'Vorschau' },
        { role: 'link', label: 'Bearbeiten' },
        { role: 'button', label: 'Veröffentlichen' },
        ...move,
        { role: 'button', label: 'Löschen' },
      ] as Action[],
    },
    {
      what: "the quiz's question list",
      url: `/admin/quizzes/${content.quiz.id}`,
      row: content.question.text,
      actions: [
        { role: 'link', label: 'Bearbeiten' },
        ...move,
        { role: 'button', label: 'Löschen' },
      ] as Action[],
    },
    {
      what: "the question form's first answer",
      url: `/admin/quizzes/${content.quiz.id}/questions/${content.question.id}`,
      row: 'Antwort 1',
      actions: [
        { role: 'button', label: 'Bild auswählen' },
        ...move,
        { role: 'button', label: 'Entfernen' },
      ] as Action[],
    },
  ];
}

// How many lines the element's text takes: its text boxes, grouped by top.
async function lineCount(page: Page, row: string, item: Action): Promise<number> {
  return action(page, row, item).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => rect.top)
      .sort((a, b) => a - b);
    let lines = tops.length > 0 ? 1 : 0;
    for (let index = 1; index < tops.length; index += 1) {
      if (tops[index]! - tops[index - 1]! > 8) lines += 1;
    }
    return lines;
  });
}

// Nothing reaches past the viewport's right edge and the page doesn't scroll
// sideways.
async function expectNoSidewaysScroll(page: Page) {
  const { overflow, scrollWidth, clientWidth } = await page.evaluate(() => ({
    overflow: Math.max(
      0,
      ...Array.from(document.querySelectorAll('body *')).map(
        (element) => element.getBoundingClientRect().right - window.innerWidth,
      ),
    ),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow).toBeLessThanOrEqual(0);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("a long-named row's actions show the short labels, each on one line, and nothing scrolls sideways", async ({
  page,
  request,
}, testInfo) => {
  const content = await createContent(request, testInfo);
  await signInAsAdmin(page);

  for (const { what, url, row, actions } of screens(content)) {
    await test.step(what, async () => {
      await page.goto(url);
      for (const item of actions) {
        const control = action(page, row, item);
        await expect(control, `${what}: "${spoken(item.label)}: …"`).toBeVisible();
        await expect(control).toHaveText(shownAs(item.label));
        expect(await lineCount(page, row, item), `${what}: "${item.label}" wraps`).toBe(1);
      }
      await expectNoSidewaysScroll(page);
    });
  }
});

// How a control looks: its border color and the color of its text (the
// innermost element that holds it).
async function look(page: Page, row: string, item: Action): Promise<string> {
  return action(page, row, item).evaluate((element) => {
    const leaves = Array.from(element.querySelectorAll('*')).filter(
      (node) => node.children.length === 0 && (node.textContent ?? '').trim() !== '',
    );
    const text = leaves.at(-1) ?? element;
    return `${getComputedStyle(element).borderColor} / ${getComputedStyle(text).color}`;
  });
}

test('delete stays visually distinct from the other actions with the short labels', async ({
  page,
  request,
}, testInfo) => {
  const content = await createContent(request, testInfo);
  await signInAsAdmin(page);

  for (const { what, url, row, actions } of screens(content)) {
    await test.step(what, async () => {
      await page.goto(url);
      // Delete ("Löschen", "Entfernen") comes last; the row's first other
      // button is a plain one.
      const remove = actions.at(-1)!;
      const plain = actions.find((item) => item.role === 'button' && item !== remove)!;
      await expect(action(page, row, remove)).toHaveText(shownAs(remove.label));
      await expect(action(page, row, plain)).toHaveText(shownAs(plain.label));
      expect(
        await look(page, row, remove),
        `${what}: "${remove.label}" looks like "${plain.label}"`,
      ).not.toBe(await look(page, row, plain));
    });
  }
});

test('axe passes on the admin lists and the question form with the short labels', async ({
  page,
  request,
}, testInfo) => {
  const content = await createContent(request, testInfo);
  await signInAsAdmin(page);

  for (const { what, url, row, actions } of screens(content)) {
    await test.step(what, async () => {
      await page.goto(url);
      // The screen shows its short labels before axe looks at it.
      await expect(action(page, row, actions[0]!)).toHaveText(shownAs(actions[0]!.label));
      await expectNoSeriousAxeViolations(page);
    });
  }
});
