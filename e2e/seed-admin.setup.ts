import { test as setup } from '@playwright/test';

import {
  passwordSession,
  SEED_ADMIN,
  SEED_ADMIN_STORAGE_STATE,
  saveSeedAdminAccessToken,
  signInAsSeedAdmin,
  stepUp,
} from './admin-auth';

// The setup project of playwright.config.ts (#122), run once before the
// phone and desktop projects, which depend on it: the seed admin signs in
// with password and TOTP code, once in the browser and once over HTTP, and
// both aal2 sessions are saved for the whole run (see the notes on
// SEED_ADMIN_STORAGE_STATE in ./admin-auth). The two sign-ins run one after
// the other, so neither verify can end the other's session halfway.

setup(
  'the seed admin signs in with password and code, and its aal2 sessions are saved',
  async ({ page, request }) => {
    await signInAsSeedAdmin(page);
    await page.context().storageState({ path: SEED_ADMIN_STORAGE_STATE });

    const session = await passwordSession(request, SEED_ADMIN.email, SEED_ADMIN.password);
    saveSeedAdminAccessToken(await stepUp(request, session, SEED_ADMIN.totpSecret));
  },
);
