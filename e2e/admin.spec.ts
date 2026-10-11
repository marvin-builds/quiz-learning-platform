import { expect, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// The admin area against the local stack: the seed admin (supabase/seed.sql,
// admin@example.com / admin-password) signs in at /admin/sign-in and reaches
// the dashboard at /admin; an anonymous visitor opening /admin doesn't see
// it. Runs once per project in playwright.config.ts (phone and desktop);
// every test starts in a fresh browser context without a session.

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password';

// Reads a text from de.json by path, so keys that don't exist yet fail at run
// time with their name instead of breaking the typecheck.
function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
}

function text(key: string): string {
  const value = lookup(key);
  if (typeof value !== 'string') throw new Error(`de.json has no text for ${key}`);
  return value;
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

const signInHeading = (page: Page) =>
  page.getByRole('heading', { name: text('admin.signIn.title'), exact: true });
const dashboardHeading = (page: Page) =>
  page.getByText(text('admin.dashboard.title'), { exact: true });

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/admin/sign-in');
  await expect(signInHeading(page)).toBeVisible();
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(email);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
}

// The issue allows either a redirect to the sign-in screen or a "no access"
// state on /admin; either way the dashboard stays hidden.
async function expectKeptOut(page: Page) {
  const noAccess =
    typeof lookup('admin.guard.noAccess') === 'string'
      ? page.getByText(text('admin.guard.noAccess'), { exact: true })
      : null;
  const keptOut = noAccess ? signInHeading(page).or(noAccess) : signInHeading(page);
  await expect(keptOut).toBeVisible();
  await expect(dashboardHeading(page)).toBeHidden();
}

test('the sign-in screen labels its fields and passes axe', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/admin/sign-in');

  await expect(signInHeading(page)).toBeVisible();
  await expect(page.getByLabel(text('admin.signIn.email'), { exact: true })).toBeVisible();
  await expect(page.getByLabel(text('admin.signIn.password'), { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await expectNoSeriousAxeViolations(page);
  expect(errors).toEqual([]);
});

test('the seed admin signs in and reaches the dashboard at /admin', async ({ page }) => {
  const errors = watchErrors(page);

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  await expect(dashboardHeading(page)).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(
    page.getByRole('link', { name: text('admin.dashboard.categories'), exact: true }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  expect(errors).toEqual([]);
});

test('a wrong password shows the wrong-credentials message', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, 'not-the-password');

  await expect(
    page.getByText(text('admin.signIn.errors.invalidCredentials'), { exact: true }),
  ).toBeVisible();
  await expect(dashboardHeading(page)).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/sign-in\/?$/);
});

test('an anonymous visitor opening /admin does not see the dashboard', async ({ page }) => {
  await page.goto('/admin');

  await expectKeptOut(page);
});

test('signing out returns to the learner area and closes /admin again', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(dashboardHeading(page)).toBeVisible();

  await page.getByRole('button', { name: text('admin.dashboard.signOut'), exact: true }).click();

  await expect(page.getByText(de.home.title, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/admin');
  await expectKeptOut(page);
});
