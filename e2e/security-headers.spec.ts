import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { watchCsp } from './csp';
import { parseCsp, parseHeadersFile } from './pages-headers';

// The web server of the e2e run (playwright.config.ts) builds with the same
// `npm run export:web` as the deploy, so dist/_headers here is the file
// Cloudflare Pages gets. These tests check that the export contains it, that
// the local server sends exactly those headers on every path (so the other
// specs run under the deployed policy), and that the policy fits the build:
// the Supabase host the bundle talks to, and the inline scripts of index.html.

const DIST = path.join(process.cwd(), 'dist');
const HAUPTSTAEDTE = '20000000-0000-4000-8000-000000000001';

function headersRule(): Map<string, string> {
  const file = path.join(DIST, '_headers');
  expect(existsSync(file), 'the export wrote no dist/_headers').toBe(true);
  const rule = parseHeadersFile(readFileSync(file, 'utf8')).get('/*');
  expect(rule, 'dist/_headers has no rule for /*').toBeDefined();
  return rule!;
}

function cspOfExport(): Map<string, string[]> {
  const policy = headersRule().get('content-security-policy');
  expect(policy, 'dist/_headers sends no Content-Security-Policy').toBeDefined();
  return parseCsp(policy!);
}

const indexHtml = () => readFileSync(path.join(DIST, 'index.html'), 'utf8');

test('the export contains _headers with a CSP for every path', () => {
  expect(headersRule().has('content-security-policy')).toBe(true);
});

for (const [label, url] of [
  ['the start page', '/'],
  ['a deep link answered by the SPA fallback', `/quizzes/${HAUPTSTAEDTE}`],
  ['an admin route', '/admin/sign-in'],
] as const) {
  test(`the local server sends the headers of dist/_headers on ${label}`, async ({ request }) => {
    const expected = headersRule();
    const response = await request.get(url);

    expect(response.ok()).toBe(true);
    const sent = response.headers();
    for (const [name, value] of expected) {
      expect([name, sent[name]]).toEqual([name, value]);
    }
  });
}

test('the local server sends the headers of dist/_headers on the script bundle', async ({
  request,
}) => {
  const expected = headersRule();
  const entry = /\/_expo\/static\/js\/web\/entry-[0-9a-f]+\.js/.exec(indexHtml())?.[0];
  expect(entry, 'dist/index.html loads no entry bundle').toBeDefined();
  const response = await request.get(entry!);

  expect(response.ok()).toBe(true);
  const sent = response.headers();
  for (const [name, value] of expected) {
    expect([name, sent[name]]).toEqual([name, value]);
  }
});

test('connect-src names the Supabase origin the bundle was built with', () => {
  const origins = (cspOfExport().get('connect-src') ?? []).filter((token) =>
    /^https?:\/\//.test(token),
  );
  const entry = /\/_expo\/static\/js\/web\/entry-[0-9a-f]+\.js/.exec(indexHtml())?.[0];
  expect(entry).toBeDefined();
  const bundle = readFileSync(path.join(DIST, entry!), 'utf8');

  expect(origins).toHaveLength(1);
  expect(bundle).toContain(origins[0]);
});

test('script-src allows every inline script of index.html by its hash', () => {
  const csp = cspOfExport();
  const scripts = csp.get('script-src') ?? csp.get('default-src') ?? [];
  // Inline scripts the browser runs: no src, and no data type such as JSON.
  const inline = [...indexHtml().matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !/\bsrc=/.test(attributes))
    .filter(([, attributes]) => {
      const type = /\btype=["']?([^"'\s>]+)/.exec(attributes)?.[1]?.toLowerCase();
      return !type || type === 'module' || /javascript|ecmascript/.test(type);
    })
    .map(([, , body]) => body)
    .filter((body) => body.trim() !== '');

  for (const body of inline) {
    const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    expect(scripts).toContain(hash);
  }
  expect(scripts).not.toContain("'unsafe-inline'");
});

// The flows rely on watchCsp to report violations; this proves it sees one
// through the securitypolicyviolation event, so an empty list there means none
// happened. The console report is a best-effort extra (its wording differs
// between browsers), so it isn't asserted here.
test('watchCsp records a violation of the served policy, naming the directive', async ({
  page,
}) => {
  const seen = await watchCsp(page);
  await page.goto('/');
  await page.evaluate(() => fetch('https://example.invalid/').catch(() => undefined));

  // The securitypolicyviolation event, through the exposed binding.
  await expect
    .poll(() =>
      seen.violations.filter((v) => /^connect-src blocked https:\/\/example\.invalid/.test(v)),
    )
    .not.toEqual([]);
});
