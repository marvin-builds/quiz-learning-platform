import { expect, type Locator, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { expectNoSeriousAxeViolations } from './axe';

// The seeded images of the quiz "Chemie-Grundlagen" (supabase/seed.sql and
// supabase/seed-images/): its first question shows a periodic table, and its
// answer Helium a balloon, both served from the public quiz-images bucket of
// the local stack. Runs once per project in playwright.config.ts (phone and
// desktop), in a fresh browser context, as an anonymous visitor.

const CHEMIE = '20000000-0000-4000-8000-000000000003';
const NOBLE_GASES = 'Welche dieser Elemente sind Edelgase?';
const PERIODIC_TABLE_ALT = 'Ausschnitt aus dem Periodensystem mit den Edelgasen';
const BALLOON_ALT = 'Mit Helium gefüllter Ballon';

function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// react-native-web renders an image as an element with role img whose picture
// is a background, plus a hidden <img> with the same source; a plain <img>
// is its own element. Both match the role, so take the outermost (first).
const imageNamed = (page: Page, name: string) =>
  page.getByRole('img', { name, exact: true }).first();

// The width the browser decoded for the image: the element's own when it is
// an <img>, else the <img> inside it.
const naturalWidthOf = (image: Locator) =>
  image.evaluate((element) => {
    const img = element instanceof HTMLImageElement ? element : element.querySelector('img');
    return img && img.complete ? img.naturalWidth : 0;
  });

async function expectLoadedAndSized(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => naturalWidthOf(image)).toBeGreaterThan(0);
  const box = await image.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);
}

test('the seeded question and answer images load at a visible size, and the question passes axe', async ({
  page,
}) => {
  const errors = watch(page);

  await page.goto(`/quizzes/${CHEMIE}`);
  await page.getByRole('button', { name: de.quiz.start, exact: true }).click();
  await expect(page.getByText(NOBLE_GASES, { exact: true })).toBeVisible();

  await expectLoadedAndSized(imageNamed(page, PERIODIC_TABLE_ALT));
  await expectLoadedAndSized(imageNamed(page, BALLOON_ALT));

  await expectNoSeriousAxeViolations(page);
  expect(errors).toEqual([]);
});
