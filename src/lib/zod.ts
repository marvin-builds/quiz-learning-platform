// The app's only entry to zod (a lint rule forbids importing `zod` anywhere
// else), so it is configured before any schema parses: without `jitless`, zod
// probes `new Function` on the first object parse, which the web app's CSP
// (no 'unsafe-eval', scripts/security-headers.mjs) reports as a violation even
// though zod catches it.
import { z } from 'zod';

z.config({ jitless: true });

export { z };
