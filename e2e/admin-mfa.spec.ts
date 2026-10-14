import { expect, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import {
  createAdminWithoutFactor,
  enterTotpCode,
  removeAdmin,
  SEED_ADMIN,
  signInWithPassword,
} from './admin-auth';
import { expectNoSeriousAxeViolations } from './axe';
import { totp } from './totp';

// Admin rights need a second factor (#122), against the local stack, once
// per project of playwright.config.ts (phone 390 px and desktop 1280 px):
// - The seed admin (supabase/seed.sql) has a verified TOTP factor: after the
//   password the admin area asks for the code, not the category list; a
//   wrong code shows its own message; the right code opens the category
//   list. The challenge passes axe.
// - An admin without a factor (created for the test, as the hosted admin is
//   right after the deploy) gets the enrollment: a QR code with an alt text
//   and the secret as text; the code from that secret opens the category
//   list, and the next sign-in asks for the code instead. The enrollment
//   passes axe.
// - Sign-out stays in the admin header on both steps.
// Every test starts in a fresh browser context without a session.

function text(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
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

const heading = (page: Page, key: string) =>
  page.getByRole('heading', { name: text(key), exact: true });

const signOut = (page: Page) => {
  const header = page.getByRole('banner');
  return header
    .getByRole('button', { name: text('nav.signOut'), exact: true })
    .or(header.getByRole('link', { name: text('nav.signOut'), exact: true }));
};

// A six-digit code that is none of the codes GoTrue may accept right now
// (it allows a step of clock skew either way).
function wrongCode(secret: string): string {
  const now = Date.now();
  const valid = new Set([
    totp(secret, now - 30_000),
    totp(secret, now),
    totp(secret, now + 30_000),
  ]);
  for (const candidate of ['000000', '111111', '222222', '333333']) {
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('unreachable');
}

test('after the password the seed admin is asked for the code, and the challenge passes axe', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await signInWithPassword(page, SEED_ADMIN.email, SEED_ADMIN.password);

  await expect(heading(page, 'admin.mfa.challenge.title')).toBeVisible();
  await expect(page.getByLabel(text('admin.mfa.code'), { exact: true })).toBeVisible();
  await expect(heading(page, 'admin.categories.title')).toBeHidden();
  await expect(heading(page, 'admin.mfa.enroll.title')).toBeHidden();
  await expectNoSeriousAxeViolations(page);
  expect(errors).toEqual([]);
});

test('a wrong code shows the wrong-code message; the right code opens the category list', async ({
  page,
}) => {
  await signInWithPassword(page, SEED_ADMIN.email, SEED_ADMIN.password);
  await expect(heading(page, 'admin.mfa.challenge.title')).toBeVisible();

  await page
    .getByLabel(text('admin.mfa.code'), { exact: true })
    .fill(wrongCode(SEED_ADMIN.totpSecret));
  await page.getByRole('button', { name: text('admin.mfa.submit'), exact: true }).click();

  await expect(page.getByText(text('admin.mfa.errors.invalidCode'), { exact: true })).toBeVisible();
  await expect(heading(page, 'admin.categories.title')).toBeHidden();

  await enterTotpCode(page, SEED_ADMIN.totpSecret);

  await expect(heading(page, 'admin.categories.title')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/categories\/?$/);
  await expect(page.getByText('Geografie', { exact: true })).toBeVisible();
});

test('sign-out in the admin header works on the code challenge', async ({ page }) => {
  await signInWithPassword(page, SEED_ADMIN.email, SEED_ADMIN.password);
  await expect(heading(page, 'admin.mfa.challenge.title')).toBeVisible();

  await signOut(page).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(de.home.title, { exact: true })).toBeVisible();
});

test.describe('an admin without a factor', () => {
  test('enrolls with the QR code and the secret, reaches the category list, and is asked for the code next time', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const admin = await createAdminWithoutFactor(request);
    try {
      await signInWithPassword(page, admin.email, admin.password);

      await expect(heading(page, 'admin.mfa.enroll.title')).toBeVisible();
      await expect(
        page.getByRole('img', { name: text('admin.mfa.enroll.qrAlt'), exact: true }),
      ).toBeVisible();
      // As one string or in groups (`KRSX G5CT …`), as authenticator apps show it.
      const secret = page.getByText(/^[A-Z2-7](?:\s?[A-Z2-7]){15,}$/);
      await expect(secret).toBeVisible();
      await expect(heading(page, 'admin.categories.title')).toBeHidden();
      await expectNoSeriousAxeViolations(page);

      await enterTotpCode(page, (await secret.textContent())!.replace(/\s/g, ''));
      await expect(page).toHaveURL(/\/admin\/categories\/?$/);

      // The factor is verified now: the next sign-in asks for the code.
      await signOut(page).click();
      await expect(page).toHaveURL(/\/$/);
      await signInWithPassword(page, admin.email, admin.password);
      await expect(heading(page, 'admin.mfa.challenge.title')).toBeVisible();
      await expect(heading(page, 'admin.mfa.enroll.title')).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await removeAdmin(request, admin);
    }
  });

  test('can sign out on the enrollment', async ({ page, request }) => {
    const admin = await createAdminWithoutFactor(request);
    try {
      await signInWithPassword(page, admin.email, admin.password);
      await expect(heading(page, 'admin.mfa.enroll.title')).toBeVisible();

      await signOut(page).click();

      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByText(de.home.title, { exact: true })).toBeVisible();
    } finally {
      await removeAdmin(request, admin);
    }
  });
});
