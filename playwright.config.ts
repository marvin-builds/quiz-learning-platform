import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

// Browser tests against the static web export, which talks to the local
// Supabase stack from .env: start and reset it first (see CLAUDE.md). In a
// worktree, .env.local (scripts/stack.mjs) points the export at the
// worktree's own stack and gives the server its own port.
function e2ePort(): number {
  const file = path.join(process.cwd(), '.env.local');
  const local = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const match = /^\s*QUIZ_E2E_PORT\s*=\s*(\d+)\s*$/m.exec(local);
  return match ? Number(match[1]) : 4173;
}

const PORT = e2ePort();
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    locale: 'de-DE',
    // Kept in test-results/, which CI uploads when a test fails.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Playwright's default browser is Chromium.
  // `setup` signs the seed admin in once with password and TOTP code and
  // saves the aal2 session for the run (e2e/seed-admin.setup.ts).
  projects: [
    { name: 'setup', testMatch: /seed-admin\.setup\.ts/ },
    {
      name: 'phone',
      use: { viewport: { width: 390, height: 844 } },
      dependencies: ['setup'],
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    // `expo serve` answers unknown paths with 404; `serve -s` falls back to
    // index.html like Cloudflare Pages does. export:web is the deploy's build,
    // dist/_headers included, and the server sends those headers too. No
    // ETag: serve answers a revalidation with a bare 304, without them.
    command: [
      'npm run -s export:web',
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/serve-config.mjs dist .expo/serve.json',
      `npx serve -s dist -c ../.expo/serve.json --no-etag -l tcp://127.0.0.1:${PORT} --no-port-switching`,
    ].join(' && '),
    url: baseURL,
    // Never test whatever else answers on the port (another worktree's build).
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
