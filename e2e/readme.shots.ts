import { expect, type Page, test } from '@playwright/test';

import de from '../src/i18n/locales/de.json';
import { openAdminAsSeedAdmin } from './admin-auth';

// The README screenshots (docs/screenshots/), taken from the showcase quiz
// "Unser Sonnensystem" in supabase/seed.sql at phone and desktop width.
// Run by `npm run screenshots:readme` (playwright.readme.config.ts), never by
// `npm run test:e2e`: the file name doesn't match its *.spec.ts.

const SOLAR_SYSTEM = '20000000-0000-4000-8000-000000000006';
const LARGEST_PLANET = '30000000-0000-4000-8000-000000000013';

function text(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], de);
  if (typeof value !== 'string') throw new Error(`No German text for ${key}`);
  return value;
}

async function shoot(page: Page, name: string): Promise<void> {
  // Every image loaded, scrolled to the top: a shot shows the screen as it opens.
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete && image.naturalWidth > 0),
  );
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('*').forEach((element) => {
      if (element.scrollTop) element.scrollTop = 0;
    });
  });
  const viewport = test.info().project.name;
  await page.screenshot({ path: `docs/screenshots/${viewport}-${name}.png` });
}

test('learner screens', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Weltraum', { exact: true }).waitFor();
  await shoot(page, 'categories');

  await page.goto(`/quizzes/${SOLAR_SYSTEM}`);
  await page.getByRole('button', { name: text('quiz.start'), exact: true }).click();
  await page.getByText('Welcher Planet ist hier zu sehen?').waitFor();
  await page.getByText('Saturn', { exact: true }).click();
  await page.getByRole('button', { name: text('quiz.submit'), exact: true }).click();
  await page.getByText(/auffälligen Ringen/).waitFor();
  await shoot(page, 'feedback');

  await page.getByRole('button', { name: text('quiz.next'), exact: true }).click();
  await page.getByText('Welcher dieser Planeten ist der größte?').waitFor();
  await shoot(page, 'answer-images');
});

test('admin question editor', async ({ page }) => {
  await openAdminAsSeedAdmin(page);
  await page.goto(`/admin/quizzes/${SOLAR_SYSTEM}/questions/${LARGEST_PLANET}`);
  await expect(page.getByRole('textbox').first()).toHaveValue(
    'Welcher dieser Planeten ist der größte?',
  );
  await shoot(page, 'admin-question');
});
