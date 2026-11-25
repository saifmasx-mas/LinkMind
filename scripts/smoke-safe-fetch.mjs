// Light smoke test for the safe-fetch IP blocklist.
//
// Run: node scripts/smoke-safe-fetch.mjs
//
// Uses IP-literal URLs so no DNS lookup is involved. A public address must
// NOT be rejected by the blocklist — in a sandboxed environment the
// connection itself will then fail with a network error, which still
// proves the blocklist let it through. Private, loopback, link-local and
// IPv4-mapped private addresses MUST be rejected by the blocklist before
// any network attempt.
//
// Regression test for: the '::ffff:0:0/96' IPv6 blocklist rule matched
// every IPv4 address (Node represents IPv4 as ::ffff:a.b.c.d), so every
// public fetch threw "URL host does not resolve exclusively to public
// IP addresses" and all content sources returned null.

import { fetchPublicUrl } from '../lib/safe-fetch.ts';

const BLOCKED_MSG =
  'URL host does not resolve exclusively to public IP addresses';

const cases = [
  // [url, expectBlocked]
  ['http://8.8.8.8/', false],
  // https here on purpose: the http URL 301-redirects to www.google.com,
  // whose DNS resolves to blocked 198.18.x.x addresses in this sandbox,
  // which would look like a blocklist failure of the IP itself.
  ['https://142.250.72.206/', false],
  ['http://10.0.0.5/', true],
  ['http://192.168.1.1/', true],
  ['http://127.0.0.1/', true],
  ['http://198.18.5.5/', true],
  ['http://[::ffff:10.0.0.1]/', true],
  ['http://[::ffff:192.168.1.1]/', true],
  ['http://[::ffff:127.0.0.1]/', true],
];

let failures = 0;
for (const [url, expectBlocked] of cases) {
  let blocked = false;
  let detail = 'unexpected success (no fetch attempted?)';
  try {
    await fetchPublicUrl(url);
    detail = 'responded (not blocked)';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    blocked = message === BLOCKED_MSG;
    detail = blocked ? 'blocked by blocklist' : `not blocked, network error: ${message}`;
  }
  const ok = blocked === expectBlocked;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${url.padEnd(28)} expected blocked=${expectBlocked}, ${detail}`);
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nAll blocklist smoke checks passed');
