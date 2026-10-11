import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { type Browser, expect, type Page, test, type TestInfo } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// Category CRUD with the publish toggle (#80) against the local stack: the
// seed admin (supabase/seed.sql, admin@example.com / admin-password) creates
// an unpublished category, a learner doesn't see it, the admin publishes it,
// the learner sees it after a reload, and the admin deletes it through the
// confirmation dialog. Runs once per project in playwright.config.ts (phone
// and desktop).
//
// The database is shared by every spec, so this one never edits or deletes
// seed categories: it works on a category with a unique name and deletes it
// at the end (and, should a test fail half-way, through the API afterwards).
// The learner runs in a separate browser context, a fresh anonymous session.

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

// A learner in their own browser context with this project's settings.
async function openLearner(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const { baseURL, viewport, locale } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, viewport, locale });
  return context.newPage();
}

const listHeading = (page: Page) =>
  page.getByRole('heading', { name: text('admin.categories.title'), exact: true });

const control = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true }));

const dialogOf = (page: Page) => page.getByRole('alertdialog').or(page.getByRole('dialog'));

const focusIsInDialog = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest('[role="alertdialog"], [role="dialog"]') != null,
  );

// Unique per project and run, so parallel projects and reruns don't collide.
function uniqueName(testInfo: TestInfo): string {
  return `E2E Kategorie ${testInfo.project.name} ${Date.now()}`;
}

const created: string[] = [];

// Best effort: removes a category a failed test left behind, as the admin
// through the API. Before the admin may delete, this changes nothing.
test.afterEach(async ({ request }) => {
  const names = created.splice(0);
  if (names.length === 0) return;
  const apiUrl = setting('EXPO_PUBLIC_SUPABASE_URL');
  const key = setting('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const signIn = await request.post(`${apiUrl}/auth/v1/token?grant_type=password`, {
    headers: { apikey: key },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!signIn.ok()) return;
  const { access_token: token } = (await signIn.json()) as { access_token: string };
  for (const name of names) {
    await request.delete(`${apiUrl}/rest/v1/categories?name=eq.${encodeURIComponent(name)}`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
  }
});

test('the dashboard opens the category list, which shows unpublished categories and passes axe', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await signInAsAdmin(page);

  await page.getByRole('link', { name: text('admin.dashboard.categories'), exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(listHeading(page)).toBeVisible();
  // Seed: Musik is unpublished, Geografie published.
  await expect(page.getByText('Geografie', { exact: true })).toBeVisible();
  await expect(page.getByText('Musik', { exact: true })).toBeVisible();
  await expect(control(page, label('admin.categories.actions.publish', 'Musik'))).toBeVisible();
  await expect(
    control(page, label('admin.categories.actions.unpublish', 'Geografie')),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  expect(errors).toEqual([]);
});

test('the form rejects a blank name with its message and passes axe', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/categories/new');
  await expect(
    page.getByRole('heading', { name: text('admin.categories.form.createTitle'), exact: true }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  await page.getByLabel(text('admin.categories.form.name'), { exact: true }).fill('   ');
  await page.getByRole('button', { name: text('admin.categories.form.save'), exact: true }).click();

  await expect(
    page.getByText(text('admin.categories.form.errors.nameRequired'), { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/categories\/new\/?$/);
  await expectNoSeriousAxeViolations(page);
});

test('an admin creates an unpublished category, a learner sees it only once it is published, and the admin deletes it', async ({
  page,
  browser,
}, testInfo) => {
  const errors = watchErrors(page);
  const name = uniqueName(testInfo);
  created.push(name);
  const learner = await openLearner(browser, testInfo);

  // The admin creates the category, unpublished.
  await signInAsAdmin(page);
  await page.goto('/admin/categories');
  await expect(listHeading(page)).toBeVisible();
  await control(page, text('admin.categories.create')).click();
  await expect(page).toHaveURL(/\/admin\/categories\/new\/?$/);
  await page.getByLabel(text('admin.categories.form.name'), { exact: true }).fill(name);
  await page
    .getByLabel(text('admin.categories.form.description'), { exact: true })
    .fill('Angelegt vom E2E-Test');
  const published = page
    .getByRole('switch', { name: text('admin.categories.form.published'), exact: true })
    .or(page.getByRole('checkbox', { name: text('admin.categories.form.published'), exact: true }));
  await expect(published).not.toBeChecked();
  await page.getByRole('button', { name: text('admin.categories.form.save'), exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(control(page, label('admin.categories.actions.publish', name))).toBeVisible();

  // The learner doesn't see it.
  await learner.goto('/');
  await expect(learner.getByRole('link', { name: /Geografie/ })).toBeVisible();
  await expect(learner.getByText(name)).toHaveCount(0);

  // The admin publishes it from the list.
  await control(page, label('admin.categories.actions.publish', name)).click();
  await expect(control(page, label('admin.categories.actions.unpublish', name))).toBeVisible();

  // The learner sees it after a reload.
  await learner.reload();
  await expect(learner.getByRole('link', { name: new RegExp(escape(name)) })).toBeVisible();

  // The admin opens the delete confirmation: labelled, focus inside, axe-clean.
  const deleteButton = control(page, label('admin.categories.actions.delete', name));
  await deleteButton.click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(label('admin.categories.deleteDialog.title', name));
  await expect(dialog).toContainText(label('admin.categories.deleteDialog.message', name));
  await expect.poll(() => focusIsInDialog(page)).toBe(true);
  await expectNoSeriousAxeViolations(page);

  // Escape cancels: nothing is deleted and the focus is back on the trigger.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(deleteButton).toBeFocused();
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // The cancel button cancels too.
  await deleteButton.click();
  await dialog
    .getByRole('button', { name: text('admin.categories.deleteDialog.cancel'), exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(deleteButton).toBeFocused();
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  // Confirming deletes it, for the admin and the learner.
  await deleteButton.click();
  await dialog
    .getByRole('button', { name: text('admin.categories.deleteDialog.confirm'), exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  await learner.reload();
  await expect(learner.getByRole('link', { name: /Geografie/ })).toBeVisible();
  await expect(learner.getByText(name)).toHaveCount(0);

  await learner.context().close();
  expect(errors).toEqual([]);
});
