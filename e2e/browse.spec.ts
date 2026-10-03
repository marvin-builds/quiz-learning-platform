import { expect, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// Browsing the seed content (supabase/seed.sql) as a visitor without a
// session. Runs once per project in playwright.config.ts (phone and desktop).

const GEOGRAFIE = '10000000-0000-4000-8000-000000000001';
const GESCHICHTE = '10000000-0000-4000-8000-000000000003';
const MUSIK = '10000000-0000-4000-8000-000000000004';
const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';

// The keys are added in this slice; the de.json import is typed, so read them
// by path to keep this file compiling while they don't exist yet.
function text(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
  if (typeof value !== 'string') throw new Error(`de.json has no text for ${key}`);
  return value;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the category list shows the published categories in order and passes axe', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('link', { name: /Geografie/ })).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(escape(text('categories.title'))));
  const links = await page.getByRole('link').allInnerTexts();
  const position = (name: string) => links.findIndex((link) => link.includes(name));
  expect(position('Geografie')).toBeGreaterThanOrEqual(0);
  expect(position('Geografie')).toBeLessThan(position('Naturwissenschaften'));
  expect(position('Naturwissenschaften')).toBeLessThan(position('Geschichte'));
  await expect(page.getByText('Länder, Städte und Flüsse')).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});

test('the unpublished category is absent from the list', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('link', { name: /Geografie/ })).toBeVisible();
  await expect(page.getByText('Musik')).toHaveCount(0);
});

test('opening a category from the list shows its published quizzes and passes axe', async ({
  page,
}) => {
  await page.goto('/');

  await page.getByRole('link', { name: /Geografie/ }).click();

  await expect(page).toHaveURL(new RegExp(`/categories/${GEOGRAFIE}$`));
  const quiz = page.getByRole('link', { name: /Hauptstädte Europas/ });
  await expect(quiz).toBeVisible();
  await expect(quiz).toHaveAttribute('href', `/quizzes/${HAUPTSTAEDTE}`);
  await expect(page.getByText('Kennst du die Hauptstädte unserer Nachbarn?')).toBeVisible();
  await expect(page).toHaveTitle(/Geografie/);
  await expect(page.getByText('Flüsse in Deutschland')).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
});

test('a category without quizzes shows its empty state and passes axe', async ({ page }) => {
  await page.goto(`/categories/${GESCHICHTE}`);

  await expect(page.getByText(text('category.empty'), { exact: true })).toBeVisible();
  await expect(page.getByText('Geschichte').first()).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});

test('an unpublished category shows the not-found state with a link back to the list', async ({
  page,
}) => {
  await page.goto(`/categories/${MUSIK}`);

  await expect(page.getByText(text('category.notFound'), { exact: true })).toBeVisible();
  await expect(page.getByText('Komponisten')).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);

  await page.getByRole('link', { name: text('category.backToCategories') }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: /Geografie/ })).toBeVisible();
});

test('a category id that does not exist shows the not-found state', async ({ page }) => {
  await page.goto('/categories/gibt-es-nicht');

  await expect(page.getByText(text('category.notFound'), { exact: true })).toBeVisible();
});
