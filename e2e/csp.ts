import { expect, type Page } from '@playwright/test';

// Watches a page for the Content-Security-Policy (#123): records whether each
// document it loads arrives with a CSP header, and every violation the browser
// reports as a `securitypolicyviolation` event (plus, best effort, the
// browser's console report of one). Call it before the page's first
// navigation.
export type CspWatch = {
  // Header lookups are async (allHeaders: headers() leaves out security
  // headers), so the documents are collected as promises.
  documents: Promise<{ url: string; policy: string | null }>[];
  violations: string[];
};

export async function watchCsp(page: Page): Promise<CspWatch> {
  const seen: CspWatch = { documents: [], violations: [] };
  await page.exposeFunction('__reportCspViolation', (violation: string) => {
    seen.violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __reportCspViolation: (v: string) => void })
        .__reportCspViolation;
      report(
        `${event.effectiveDirective} blocked ${event.blockedURI || '(inline)'} on ${event.documentURI}`,
      );
    });
  });
  page.on('console', (message) => {
    if (/content[ -]security[ -]policy/i.test(message.text())) {
      seen.violations.push(message.text());
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      seen.documents.push(
        response.allHeaders().then((headers) => ({
          url: response.url(),
          policy: headers['content-security-policy'] ?? null,
        })),
      );
    }
  });
  return seen;
}

// Every document the page loaded was under a CSP, and nothing violated it.
export async function expectCspWithoutViolations(seen: CspWatch) {
  const documents = await Promise.all(seen.documents);
  expect(documents.length, 'the page loaded no document').toBeGreaterThan(0);
  expect(
    documents.filter((document) => !document.policy).map((document) => document.url),
    'documents served without a Content-Security-Policy',
  ).toEqual([]);
  expect(seen.violations).toEqual([]);
}
