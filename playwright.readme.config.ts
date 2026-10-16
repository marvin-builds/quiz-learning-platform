import { defineConfig } from '@playwright/test';

import base from './playwright.config';

// The README screenshots (e2e/readme.shots.ts) on the e2e tests' server and
// seeded local stack, at the same phone and desktop widths.
export default defineConfig({
  ...base,
  retries: 0,
  projects: (base.projects ?? []).map((project) =>
    project.name === 'setup' ? project : { ...project, testMatch: /readme\.shots\.ts/ },
  ),
});
