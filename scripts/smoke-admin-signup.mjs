// Smoke test for the admin signup notification (lib/admin.ts) and the
// standalone admin signups page (app/admin/signups/page.tsx).
//
// Run: node scripts/smoke-admin-signup.mjs
//
// No Supabase, no Telegram and no network needed: it tests the pure
// helpers the two admin API routes depend on — who counts as the admin,
// which accounts count as "just registered", and what the Telegram
// message contains — plus static checks that the signups list lives on
// its own admin-only page and that the main page only shows a link to
// it after the server confirms the caller is the admin. The routes
// themselves are verified by `tsc --noEmit` and `next build`, and the
// live behaviour (standalone admin page + Telegram message) still needs
// a real signup on the deployed site.
//
// Regression test for: the admin had to open Supabase to see who
// registered, and got no message at all when somebody signed up.

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile lib/admin.ts the same way smoke-book-summary.mjs does.
const outDir = mkdtempSync(join(process.cwd(), '.tmp-admin-signup-test-'));
try {
  execSync(
    `./node_modules/.bin/tsc lib/admin.ts --outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --declaration false`,
    { stdio: 'pipe' }
  );
} catch (error) {
  console.error(
    'Failed to compile lib/admin.ts:',
    error.stdout?.toString(),
    error.stderr?.toString()
  );
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
const { isAdminEmail, isRecentSignup, buildSignupTelegramMessage, findAuthUserByEmail, ADMIN_EMAIL } = await import(
  join(outDir, 'admin.js')
);

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const now = Date.now();
const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
const tomorrow = new Date(now + 60 * 60 * 1000).toISOString();

// 1. The admin is exactly saif.masx@gmail.com (unless ADMIN_EMAIL overrides it).
check('admin email is saif.masx@gmail.com', ADMIN_EMAIL === 'saif.masx@gmail.com', ADMIN_EMAIL);
check('exact admin email matches', isAdminEmail('saif.masx@gmail.com') === true);
check('admin email match is case-insensitive', isAdminEmail('Saif.Masx@Gmail.com') === true);
check('admin email match ignores surrounding spaces', isAdminEmail('  saif.masx@gmail.com ') === true);
check('another email is not the admin', isAdminEmail('someone@example.com') === false);
check('empty email is not the admin', isAdminEmail('') === false);
check('null email is not the admin', isAdminEmail(null) === false);
check('undefined email is not the admin', isAdminEmail(undefined) === false);

// 2. Only accounts created within the last 15 minutes count as "new".
check('signup 5 minutes ago is recent', isRecentSignup(fiveMinAgo, now) === true);
check('signup 1 hour ago is not recent', isRecentSignup(oneHourAgo, now) === false);
check('signup in the future is not recent', isRecentSignup(tomorrow, now) === false);
check('garbage date is not recent', isRecentSignup('not-a-date', now) === false);
check(
  'signup exactly at the 15-minute edge is recent',
  isRecentSignup(new Date(now - 15 * 60 * 1000).toISOString(), now) === true
);
check(
  'signup 16 minutes ago is not recent',
  isRecentSignup(new Date(now - 16 * 60 * 1000).toISOString(), now) === false
);

// 3. The Telegram message names the new user and the time, in plain text.
const msg = buildSignupTelegramMessage('new-user@example.com', fiveMinAgo);
check('message contains the new email', msg.includes('new-user@example.com'));
check('message mentions LinkMind', msg.includes('LinkMind'));
check('message has no parse_mode markup to break on', !msg.includes('<b>') && !msg.includes('*'));
check(
  'message for a bad date still contains the email',
  buildSignupTelegramMessage('x@y.com', 'not-a-date').includes('x@y.com')
);

// 4. findAuthUserByEmail pages through listUsers (fake lister, no network).
// Page 1 is full (100 users) so pagination must continue to page 2.
const page1 = Array.from({ length: 100 }, (_, i) => ({
  id: `p1-${i}`,
  email: `user${i}@example.com`,
  created_at: oneHourAgo,
}));
page1[1] = { id: 'u2', email: 'Second@Example.com', created_at: oneHourAgo };
const fakeLister = {
  async listUsers({ page }) {
    const pages = {
      1: page1,
      2: [{ id: 'u3', email: 'third@example.com', created_at: fiveMinAgo }],
    };
    return { data: { users: pages[page] ?? [] }, error: null };
  },
};
const foundSecond = await findAuthUserByEmail(fakeLister, 'second@example.com');
check(
  'finds a user on page 1, case-insensitively',
  foundSecond?.id === 'u2',
  foundSecond?.id
);
const foundThird = await findAuthUserByEmail(fakeLister, 'THIRD@example.com');
check('finds a user on page 2', foundThird?.id === 'u3', foundThird?.id);
const foundNone = await findAuthUserByEmail(fakeLister, 'nobody@example.com');
check('missing email returns null', foundNone === null);
const foundEmpty = await findAuthUserByEmail(fakeLister, '   ');
check('blank email returns null', foundEmpty === null);
const errorLister = {
  async listUsers() {
    return { data: null, error: { message: 'boom' } };
  },
};
check(
  'list error returns null instead of throwing',
  (await findAuthUserByEmail(errorLister, 'a@b.com')) === null
);

rmSync(outDir, { recursive: true, force: true });

// 5. The signups list lives on its own admin-only page now — the main
// page must not render the list, and its link to the page must only
// ever appear after the server confirms the caller is the admin.
const adminPagePath = 'app/admin/signups/page.tsx';
check('standalone admin signups page exists', existsSync(adminPagePath));
const adminPage = existsSync(adminPagePath)
  ? readFileSync(adminPagePath, 'utf8')
  : '';
check(
  'admin page loads the list from /api/admin/signups',
  adminPage.includes("fetch('/api/admin/signups'")
);
check(
  'admin page refuses non-admins on 401/403',
  adminPage.includes('401') &&
    adminPage.includes('403') &&
    adminPage.includes('adminSubscribersForbidden')
);
check(
  'admin page links back to the library',
  adminPage.includes('href="/"')
);
const mainPage = readFileSync('app/page.tsx', 'utf8');
check(
  'main page no longer renders the signups list',
  !mainPage.includes('recentSignups') && !mainPage.includes('totalSignups')
);
check(
  'main page shows the admin link only after the server confirms admin',
  mainPage.includes('{user && isAdmin &&') &&
    mainPage.includes('href="/admin/signups"')
);
check(
  'main page links to the admin page exactly once',
  mainPage.split('href="/admin/signups"').length - 1 === 1
);

console.log(failures === 0 ? '\nAll admin signup checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
