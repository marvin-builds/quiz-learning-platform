#!/usr/bin/env node
// Removes the images no question or answer names any more (#125).
//
//   SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/clean-up-images.mjs
//
// Asks public.orphaned_quiz_images(now - GRACE_PERIOD_HOURS) which objects of
// the quiz-images bucket nothing names, and removes them through the Storage
// API in batches, so the public file goes too (Storage refuses a direct SQL
// delete). The grace period lets an upload whose save is still running
// survive. Only the service role may call that function, so the script needs
// the project's secret key; a GitHub Actions schedule runs it
// (.github/workflows/clean-up-images.yml).
//
// Exits non-zero when the function refuses, or when a removal fails or
// removes less than it was asked to, so a scheduled run never looks green
// while orphans stay public.
//
// `--now <ISO time>` replaces the clock, for the stack tests only
// (tests/stack/clean-up-images.stack.test.ts); the schedule never passes it.

const BUCKET = 'quiz-images';
const GRACE_PERIOD_HOURS = 24;
const BATCH_SIZE = 100;
// Each round lists at most PostgREST's max_rows names and removes all of them,
// or the run stops; the cap only guards against a listing that never shrinks.
const MAX_ROUNDS = 100;

class CleanupError extends Error {}

function parseNow(args) {
  const index = args.indexOf('--now');
  if (index === -1) return new Date();
  const now = new Date(args[index + 1] ?? '');
  if (Number.isNaN(now.getTime())) throw new CleanupError('--now needs an ISO time');
  return now;
}

function environment() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const missing = [!url && 'SUPABASE_URL', !key && 'SUPABASE_SECRET_KEY'].filter(Boolean);
  if (missing.length > 0) throw new CleanupError(`missing ${missing.join(' and ')}`);
  return { url: url.replace(/\/+$/, ''), key };
}

async function call({ url, key }, method, route, body) {
  let response;
  try {
    response = await fetch(`${url}${route}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new CleanupError(`${method} ${route} failed: ${cause.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CleanupError(`${method} ${route} answered ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CleanupError(`${method} ${route} answered no JSON: ${text}`);
  }
}

async function listOrphans(api, olderThan) {
  const names = await call(api, 'POST', '/rest/v1/rpc/orphaned_quiz_images', {
    older_than: olderThan.toISOString(),
  });
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new CleanupError('orphaned_quiz_images returned no list of names');
  }
  return names;
}

async function remove(api, names) {
  for (let start = 0; start < names.length; start += BATCH_SIZE) {
    const batch = names.slice(start, start + BATCH_SIZE);
    const removed = await call(api, 'DELETE', `/storage/v1/object/${BUCKET}`, {
      prefixes: batch,
    });
    const gone = new Set(Array.isArray(removed) ? removed.map((object) => object?.name) : []);
    const left = batch.filter((name) => !gone.has(name));
    if (left.length > 0) {
      throw new CleanupError(`Storage did not remove ${left.length} object(s): ${left.join(', ')}`);
    }
  }
}

async function main() {
  const now = parseNow(process.argv.slice(2));
  const api = environment();
  const olderThan = new Date(now.getTime() - GRACE_PERIOD_HOURS * 60 * 60 * 1000);
  let total = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const names = await listOrphans(api, olderThan);
    if (names.length === 0) {
      console.log(`Removed ${total} unreferenced image(s) older than ${olderThan.toISOString()}.`);
      return;
    }
    await remove(api, names);
    total += names.length;
  }
  throw new CleanupError(`still listing orphans after ${MAX_ROUNDS} rounds (${total} removed)`);
}

main().catch((error) => {
  console.error(`clean-up-images: ${error instanceof CleanupError ? error.message : error}`);
  process.exitCode = 1;
});
