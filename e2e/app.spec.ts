import { expect, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// Runs once per project in playwright.config.ts (phone and desktop), so the
// spec needs no code per screen size.

test('the app loads, shows its German title, logs no console errors and passes axe', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');

  await expect(page.getByText(de.home.title, { exact: true })).toBeVisible();
  // Wait until the database check has settled, so errors it causes are caught.
  await expect(page.getByText(de.home.dbStatus.loading, { exact: true })).toBeHidden();
  await expectNoSeriousAxeViolations(page);
  expect(errors).toEqual([]);
});

test('a deep link is served the app through SPA fallback, not a server 404', async ({ page }) => {
  const response = await page.goto('/eine/tiefe/route');

  expect(response?.status()).toBe(200);
  await expect(page.locator('#root')).not.toBeEmpty();
});
