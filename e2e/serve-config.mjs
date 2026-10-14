// Turns the `/*` rule of dist/_headers (scripts/security-headers.mjs) into a
// `serve` configuration, so the local e2e server sends the headers Cloudflare
// Pages sends: `node e2e/serve-config.mjs <dist> <out.json>`, then
// `serve -c <out.json>`. Outside dist/, so it isn't deployed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseHeadersFile } from './pages-headers.ts';

const [dist = 'dist', out = '.expo/serve.json'] = process.argv.slice(2);
const rules = parseHeadersFile(readFileSync(path.join(dist, '_headers'), 'utf8'));
const all = rules.get('/*');
if (!all || rules.size !== 1) {
  console.error('serve-config: dist/_headers must hold exactly one rule, for /*');
  process.exit(1);
}

const config = {
  headers: [{ source: '**', headers: [...all].map(([key, value]) => ({ key, value })) }],
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
