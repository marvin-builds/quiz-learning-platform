import { expect, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';
import { enterTotpCode, SEED_ADMIN } from './admin-auth';

// The admin area against the local stack: the seed admin (supabase/seed.sql,
// admin@example.com / admin-password) signs in at /admin/sign-in and reaches
// the admin start, the category list at /admin/categories; an anonymous
// visitor opening /admin doesn't see it. Runs once per project in playwright.config.ts (phone and desktop);
// every test starts in a fresh browser context without a session.
//
// Re-spec (#116): the dashboard is gone. The admin start is the category
// list at /admin/categories, where the sign-in and /admin land, and
// "Abmelden" sits in the admin header (`nav.signOut`).

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
// Re-spec (#116): the admin start, the category list, instead of the dashboard.
const adminStartHeading = (page: Page) =>
  page.getByRole('heading', { name: text('admin.categories.title'), exact: true });

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/admin/sign-in');
  await expect(signInHeading(page)).toBeVisible();
  await page.getByLabel(text('admin.signIn.email'), { exact: true }).fill(email);
  await page.getByLabel(text('admin.signIn.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: text('admin.signIn.submit'), exact: true }).click();
}

// The issue allows either a redirect to the sign-in screen or a "no access"
// state on /admin; either way the admin start stays hidden.
async function expectKeptOut(page: Page) {
  const noAccess =
    typeof lookup('admin.guard.noAccess') === 'string'
      ? page.getByText(text('admin.guard.noAccess'), { exact: true })
      : null;
  const keptOut = noAccess ? signInHeading(page).or(noAccess) : signInHeading(page);
  await expect(keptOut).toBeVisible();
  await expect(adminStartHeading(page)).toBeHidden();
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

// Re-spec (#116): was "reaches the dashboard at /admin".
test('the seed admin signs in and reaches the category list at /admin/categories', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);

  await expect(adminStartHeading(page)).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(page.getByText('Geografie', { exact: true })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  expect(errors).toEqual([]);
});

test('a wrong password shows the wrong-credentials message', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, 'not-the-password');

  await expect(
    page.getByText(text('admin.signIn.errors.invalidCredentials'), { exact: true }),
  ).toBeVisible();
  await expect(adminStartHeading(page)).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/sign-in\/?$/);
});

// The disabled button loses the focus while signing in; keyboard users get
// it back at the start of the form instead of nowhere.
test('after a failed sign-in the focus is back in the email field', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, 'not-the-password');

  await expect(
    page.getByText(text('admin.signIn.errors.invalidCredentials'), { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(text('admin.signIn.email'), { exact: true })).toBeFocused();
});

test('an anonymous visitor opening /admin does not see the admin start', async ({ page }) => {
  await page.goto('/admin');

  await expectKeptOut(page);
});

test('signing out returns to the learner area and closes /admin again', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  await expect(adminStartHeading(page)).toBeVisible();

  // Re-spec (#116): "Abmelden" is in the admin header, a link or a button.
  const header = page.getByRole('banner');
  await header
    .getByRole('button', { name: text('nav.signOut'), exact: true })
    .or(header.getByRole('link', { name: text('nav.signOut'), exact: true }))
    .click();

  await expect(page.getByText(de.home.title, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/admin');
  await expectKeptOut(page);
});

// The admin policies let RLS return drafts to an admin, so the learner area
// filters on `published` itself: a signed-in admin sees it like a learner.
// Seed (supabase/seed.sql): Musik is an unpublished category, Flüsse in
// Deutschland a draft in Geografie, Komponisten a published quiz in Musik.
test('a signed-in admin sees the learner area without drafts', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  // Re-spec (#122): the TOTP code after the password.
  await enterTotpCode(page, SEED_ADMIN.totpSecret);
  await expect(adminStartHeading(page)).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('Geografie', { exact: true })).toBeVisible();
  await expect(page.getByText('Musik', { exact: true })).toBeHidden();

  await page.goto('/categories/10000000-0000-4000-8000-000000000004');
  await expect(page.getByText(de.category.notFound, { exact: true })).toBeVisible();

  await page.goto('/categories/10000000-0000-4000-8000-000000000001');
  await expect(page.getByText('Hauptstädte Europas', { exact: true })).toBeVisible();
  await expect(page.getByText('Flüsse in Deutschland', { exact: true })).toBeHidden();

  await page.goto('/quizzes/20000000-0000-4000-8000-000000000002');
  await expect(page.getByText(de.quiz.notFound, { exact: true })).toBeVisible();

  await page.goto('/quizzes/20000000-0000-4000-8000-000000000004');
  await expect(page.getByText(de.quiz.notFound, { exact: true })).toBeVisible();
});
