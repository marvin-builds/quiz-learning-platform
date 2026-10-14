import { expect, type Locator, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';
import { enterTotpCode, SEED_ADMIN } from './admin-auth';

// Issue #116 on the seed content (supabase/seed.sql), once per project in
// playwright.config.ts (phone 390 px and desktop 1280 px): every screen has a
// header landmark, the admin screens a labelled breadcrumb `nav` with
// aria-current on the current page; a learner and an admin get around using
// only the in-app navigation (no page.goto after the start, no browser
// back); every header and breadcrumb target is at least 44 px and the
// keyboard reaches and uses them; axe passes on every screen visited. On a
// phone the breadcrumb shows only "← parent" and the current title, on one
// line; on the desktop the whole chain. The flows only navigate and never
// save, so the seed stays as it is.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password';

const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';
const ITALY = '30000000-0000-4000-8000-000000000002';
const QUIZ_TITLE = 'Hauptstädte Europas';
const FRANCE_TEXT = 'Was ist die Hauptstadt von Frankreich?';
const ITALY_TEXT = 'Was ist die Hauptstadt von Italien?';

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

// A navigation label, optionally after a decorative arrow or cross.
const navName = (label: string) => new RegExp(`^(?:[←✕×‹<]\\s*)?${escape(label)}$`);

const header = (page: Page) => page.getByRole('banner');
const breadcrumb = (page: Page) =>
  page.getByRole('navigation', { name: text('nav.breadcrumb.label'), exact: true });

// A header or breadcrumb control: a link, or a button where it may ask first.
const control = (scope: Locator, label: string) =>
  scope
    .getByRole('link', { name: navName(label) })
    .or(scope.getByRole('button', { name: navName(label) }));

const isPhone = () => test.info().project.name === 'phone';

// Collects console errors and page errors over the whole test.
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// Every visible link and button in the header (and the breadcrumb) is at
// least 44 × 44 px.
async function expectTargetsAtLeast44(page: Page) {
  const targets = page
    .getByRole('banner')
    .or(page.getByRole('navigation'))
    .locator('a, button, [role="link"], [role="button"]');
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index);
    if (!(await target.isVisible())) continue;
    const box = await target.boundingBox();
    const name = (await target.innerText()).trim();
    expect(box, `the target "${name}" has no box`).not.toBeNull();
    expect(box!.height, `the target "${name}" is lower than 44 px`).toBeGreaterThanOrEqual(44);
    expect(box!.width, `the target "${name}" is narrower than 44 px`).toBeGreaterThanOrEqual(44);
  }
}

// Presses Tab until `target` has the focus (it is reachable by keyboard),
// then Enter (it is usable by keyboard).
async function activateByKeyboard(page: Page, target: Locator) {
  for (let presses = 0; presses < 40; presses += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press('Enter');
      return;
    }
  }
  throw new Error('Tab never reached the target');
}

// The breadcrumb's current segment carries aria-current="page" and shows
// `current`; on a phone it stays on one line.
async function expectCurrent(page: Page, current: string) {
  const nav = breadcrumb(page);
  await expect(nav.locator('[aria-current="page"]').filter({ visible: true })).toHaveText(
    navName(current),
  );
  if (isPhone()) {
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    // One row of 44 px targets, never two.
    expect(box!.height).toBeLessThan(88);
  }
}

// On a phone only the parent is linked; on a desktop the whole chain.
async function expectChain(page: Page, chain: string[]) {
  const nav = breadcrumb(page);
  const parent = chain[chain.length - 1];
  await expect(control(nav, parent).filter({ visible: true })).toHaveCount(1);
  for (const ancestor of chain.slice(0, -1)) {
    await expect(control(nav, ancestor).filter({ visible: true })).toHaveCount(isPhone() ? 0 : 1);
  }
}

async function expectScreenChecks(page: Page) {
  await expect(header(page)).toBeVisible();
  await expectTargetsAtLeast44(page);
  await expectNoSeriousAxeViolations(page);
}

test('a learner goes home → category → quiz → leaves → home using only the in-app navigation', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await expect(page.getByRole('link', { name: /Geografie/ })).toBeVisible();
  await expect(control(header(page), text('nav.appName'))).toBeVisible();
  await expect(control(header(page), text('nav.admin'))).toHaveCount(0);
  await expectScreenChecks(page);

  await page.getByRole('link', { name: /Geografie/ }).click();
  await expect(page).toHaveURL(new RegExp(`/categories/${GEOGRAFIE}$`));
  await expect(header(page).getByText('Geografie', { exact: true })).toBeVisible();
  await expectScreenChecks(page);

  await page.getByRole('link', { name: new RegExp(QUIZ_TITLE) }).click();
  await expect(page).toHaveURL(new RegExp(`/quizzes/${HAUPTSTAEDTE}$`));
  await expectScreenChecks(page);

  await page.getByRole('button', { name: text('quiz.start'), exact: true }).click();
  await expect(page.getByText(FRANCE_TEXT, { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /^Paris(?!\w)|(?<!\w)Paris$/ }).click();
  await page.getByRole('button', { name: text('quiz.submit'), exact: true }).click();
  await expect(page.getByRole('button', { name: text('quiz.next'), exact: true })).toBeVisible();
  await expectScreenChecks(page);

  // After an answer, leaving asks first; the dialog passes axe too.
  await control(header(page), text('nav.leaveQuiz')).click();
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(dialog.getByText(text('nav.leaveDialog.message'), { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await dialog.getByRole('button', { name: text('nav.leaveDialog.confirm'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/categories/${GEOGRAFIE}$`));

  // Up to the categories, by keyboard.
  await activateByKeyboard(page, control(header(page), text('nav.categories')));
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: /Geografie/ })).toBeVisible();

  expect(errors).toEqual([]);
});

test('an admin goes categories → quiz → question → preview → back up to the categories and to the app using only the header', async ({
  page,
}) => {
  const errors = watchErrors(page);

  // The sign-in screen has the admin header without the breadcrumb.
  await page.goto('/admin/sign-in');
  await expect(header(page)).toBeVisible();
  await expect(control(header(page), text('nav.toApp'))).toBeVisible();
  await expect(control(header(page), text('nav.signOut'))).toHaveCount(0);
  await expect(breadcrumb(page)).toHaveCount(0);
  await expectScreenChecks(page);
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);

  // The admin start is the category list.
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(control(header(page), text('nav.admin'))).toBeVisible();
  await expect(control(header(page), text('nav.toApp'))).toBeVisible();
  await expect(control(header(page), text('nav.signOut'))).toBeVisible();
  await expectCurrent(page, text('nav.breadcrumb.categories'));
  await expectScreenChecks(page);

  await page
    .getByRole('link', { name: text('admin.categories.actions.quizzes', { name: 'Geografie' }) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${GEOGRAFIE}$`));
  await expectCurrent(page, 'Geografie');
  await expectChain(page, [text('nav.breadcrumb.categories')]);
  await expectScreenChecks(page);

  await page
    .getByRole('link', { name: text('admin.quizzes.actions.questions', { name: QUIZ_TITLE }) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${HAUPTSTAEDTE}$`));
  await expectCurrent(page, QUIZ_TITLE);
  await expectChain(page, [text('nav.breadcrumb.categories'), 'Geografie']);
  await expectScreenChecks(page);

  await page
    .getByRole('link', { name: text('admin.questions.actions.edit', { name: ITALY_TEXT }) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}$`));
  await expect(page.getByLabel(text('admin.questions.form.text'), { exact: true })).toHaveValue(
    ITALY_TEXT,
  );
  await expectCurrent(page, text('nav.breadcrumb.question', { number: 2 }));
  await expectChain(page, [text('nav.breadcrumb.categories'), 'Geografie', QUIZ_TITLE]);
  await expectScreenChecks(page);

  // Up to the quiz, unchanged form: no question.
  await control(breadcrumb(page), QUIZ_TITLE).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${HAUPTSTAEDTE}$`));

  await page
    .getByRole('link', { name: text('admin.questions.preview', { name: QUIZ_TITLE }) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${HAUPTSTAEDTE}/preview$`));
  await expectCurrent(page, text('nav.breadcrumb.preview'));
  await expectChain(page, [text('nav.breadcrumb.categories'), 'Geografie', QUIZ_TITLE]);
  await expectScreenChecks(page);

  // The preview's way back to its quiz, by keyboard.
  await activateByKeyboard(page, control(breadcrumb(page), QUIZ_TITLE).filter({ visible: true }));
  await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${HAUPTSTAEDTE}$`));

  await control(breadcrumb(page), 'Geografie').filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/categories/${GEOGRAFIE}$`));

  await control(breadcrumb(page), text('nav.breadcrumb.categories'))
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);

  await control(header(page), text('nav.toApp')).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: /Geografie/ })).toBeVisible();
  // Still signed in: the learner header offers the way back.
  await expect(control(header(page), text('nav.admin'))).toBeVisible();
  await expectScreenChecks(page);

  expect(errors).toEqual([]);
});

test('/admin lands on the category list and "Abmelden" in the header signs out', async ({
  page,
}) => {
  await page.goto('/admin/sign-in');
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);

  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);

  await control(header(page), text('nav.signOut')).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(control(header(page), text('nav.admin'))).toHaveCount(0);
});

// A mouse click on a header or breadcrumb link stays in the app (no reload)
// and goes through the leave guard, like the buttons do.
test('a header link asks before it leaves a changed admin form or a started quiz', async ({
  page,
}) => {
  await page.goto('/admin/sign-in');
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);

  await page.goto(`/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}`);
  const field = page.getByLabel(text('admin.questions.form.text'), { exact: true });
  await expect(field).toHaveValue(ITALY_TEXT);
  await field.fill(`${ITALY_TEXT} (geändert)`);
  await page.evaluate(() => {
    (window as unknown as { notReloaded?: boolean }).notReloaded = true;
  });

  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  for (const link of [
    control(breadcrumb(page), QUIZ_TITLE).filter({ visible: true }),
    control(header(page), text('nav.toApp')),
  ]) {
    await link.click();
    await expect(
      dialog.getByText(text('nav.discardDialog.message'), { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole('button', { name: text('nav.discardDialog.cancel'), exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/admin/quizzes/${HAUPTSTAEDTE}/questions/${ITALY}$`));
    await expect(field).toHaveValue(`${ITALY_TEXT} (geändert)`);
  }
  expect(
    await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded),
  ).toBe(true);

  await page.goto(`/quizzes/${HAUPTSTAEDTE}`);
  await page.getByRole('button', { name: text('quiz.start'), exact: true }).click();
  await page.getByRole('radio', { name: /^Paris(?!\w)|(?<!\w)Paris$/ }).click();
  await page.getByRole('button', { name: text('quiz.submit'), exact: true }).click();
  await expect(page.getByRole('button', { name: text('quiz.next'), exact: true })).toBeVisible();

  await control(header(page), text('nav.appName')).click();
  await expect(dialog.getByText(text('nav.leaveDialog.message'), { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: text('nav.leaveDialog.cancel'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/quizzes/${HAUPTSTAEDTE}$`));
  await expect(page.getByRole('button', { name: text('quiz.next'), exact: true })).toBeVisible();
});
