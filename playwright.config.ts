import { defineConfig } from '@playwright/test';

// Browser tests against the static web export, which talks to the local
// Supabase stack from .env: start and reset it first (see CLAUDE.md).
const PORT = 4173;
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
  projects: [
    { name: 'phone', use: { viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    // `expo serve` answers unknown paths with 404; `serve -s` falls back to
    // index.html like Cloudflare Pages does.
    command: `npx expo export -p web && npx serve -s dist -l tcp://127.0.0.1:${PORT} --no-port-switching`,
    url: baseURL,
    // Never test whatever else answers on the port (another worktree's build).
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
