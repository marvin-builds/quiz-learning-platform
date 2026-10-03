import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { expectNoSeriousAxeViolations } from './axe';

// The shared helper in e2e/axe.ts, tested on hand-made pages so each impact
// level is known. These need no app, only the browser.

function page(body: string): string {
  return `<!doctype html><html lang="de"><head><title>Axe</title></head><body>${body}</body></html>`;
}

test.describe('expectNoSeriousAxeViolations', () => {
  test('passes an accessible page', async ({ page: browserPage }) => {
    await browserPage.setContent(page('<main><h1>Quiz</h1><p>Hallo</p></main>'));

    await expectNoSeriousAxeViolations(browserPage);
  });

  test('fails on a critical violation and names the rule', async ({ page: browserPage }) => {
    // An image without alternative text: axe rule image-alt, impact critical.
    await browserPage.setContent(
      page('<main><h1>Quiz</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>'),
    );

    await expect(expectNoSeriousAxeViolations(browserPage)).rejects.toThrow(/image-alt/);
  });

  test('fails on a serious violation and names the rule', async ({ page: browserPage }) => {
    // Light grey on white: axe rule color-contrast, impact serious.
    await browserPage.setContent(
      page('<main><h1>Quiz</h1><p style="color:#bbbbbb;background:#ffffff">Hallo</p></main>'),
    );

    await expect(expectNoSeriousAxeViolations(browserPage)).rejects.toThrow(/color-contrast/);
  });

  test('passes a page whose only violations are moderate or minor', async ({
    page: browserPage,
  }) => {
    // Content outside landmarks and no level-one heading: best-practice rules
    // of moderate impact.
    await browserPage.setContent(page('<p>Hallo</p>'));
    const { violations } = await new AxeBuilder({ page: browserPage }).analyze();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.impact === 'moderate' || v.impact === 'minor')).toBe(true);

    await expectNoSeriousAxeViolations(browserPage);
  });
});
