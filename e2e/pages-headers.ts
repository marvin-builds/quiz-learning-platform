// Reads a Cloudflare Pages `_headers` file and the policies in it. Shared by
// the Jest tests of the generator (tests/repo/security-headers.test.ts) and
// the e2e tests that check what the local server sends, so both read the file
// the same way Cloudflare does: a URL pattern at the start of a line, then
// its indented `Name: value` lines; `#` starts a comment.

export type HeaderRules = Map<string, Map<string, string>>;

export function parseHeadersFile(text: string): HeaderRules {
  const rules: HeaderRules = new Map();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim();
      current = rules.get(pattern) ?? new Map();
      rules.set(pattern, current);
      continue;
    }
    if (!current) throw new Error(`header line before any URL pattern: ${raw}`);
    const colon = raw.indexOf(':');
    if (colon === -1) throw new Error(`header line without a colon: ${raw}`);
    const name = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    // Cloudflare joins repeated headers with a comma.
    current.set(name, current.has(name) ? `${current.get(name)}, ${value}` : value);
  }
  return rules;
}

// A Content-Security-Policy as directive name -> its source tokens.
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...tokens] = part.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const key = name.toLowerCase();
    if (directives.has(key)) throw new Error(`directive ${key} appears twice`);
    directives.set(key, tokens);
  }
  return directives;
}

// A Permissions-Policy as feature -> its allowlist, e.g. `camera=()` -> '()'.
export function parsePermissionsPolicy(policy: string): Map<string, string> {
  const features = new Map<string, string>();
  for (const part of policy.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) throw new Error(`feature without an allowlist: ${trimmed}`);
    features.set(trimmed.slice(0, equals).trim(), trimmed.slice(equals + 1).trim());
  }
  return features;
}
