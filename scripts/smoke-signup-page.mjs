// Smoke test for the standalone signup page (app/signup/page.tsx).
//
// Run: node scripts/smoke-signup-page.mjs
//
// No network needed. The signup page is a React component, so this test
// asserts on the source that wires the behaviour the user asked for
// (2026-11-28 00:33, voice): the «إنشاء حساب جديد» button on the login
// card must navigate to a new signup page (with its own Google button)
// instead of running signUp in place and doing nothing visible, and a
// Turnstile widget that fails to load must show a clear message instead
// of failing silently. The real behaviour is also covered by
// `npm run lint` (tsc) and `next build`.

import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures += 1;
}

const signupPage = readFileSync('app/signup/page.tsx', 'utf8');
const mainPage = readFileSync('app/page.tsx', 'utf8');
const translations = readFileSync('lib/translations.ts', 'utf8');

// 1. The signup page exists and is a client component with the same
//    identity building blocks as the login card.
check('signup page is a client component', signupPage.includes("'use client'"));
check('signup page has email + password inputs', signupPage.includes('type="email"') && signupPage.includes('type="password"'));
check('signup page has the Google button', signupPage.includes('handleGoogleSignup') && signupPage.includes('googleBtn'));
check('signup page has the language dropdown', signupPage.includes('LanguageDropdown'));
check('signup page has a back-to-login link', signupPage.includes('href="/"') && signupPage.includes('backToLogin'));
check('signup page redirects a signed-in user home', signupPage.includes("router.replace('/')"));

// 2. The signup form actually creates the account (email + Google) and
//    notifies the admin like the old in-place flow did.
check('signup page calls supabase signUp', signupPage.includes('supabase.auth.signUp'));
check('signup page calls Google OAuth', signupPage.includes('signInWithOAuth'));
check('signup page notifies the admin on signup', signupPage.includes('notifySignup(email)'));

// 3. Turnstile: a failed widget shows a clear message in BOTH pages,
//    never a silent token clear.
check(
  'signup page Turnstile onError shows the load-failed message',
  signupPage.includes('turnstileLoadFailed')
);
check(
  'login page Turnstile onError shows the load-failed message',
  mainPage.includes('turnstileLoadFailed')
);
check(
  'no silent Turnstile onError left anywhere',
  !signupPage.includes('onError={() => setTurnstileToken(null)}') &&
    !mainPage.includes('onError={() => setTurnstileToken(null)}')
);

// 4. The login card's signup button navigates to /signup; the old
//    in-place signUp path is gone from the login page.
check('login page links to /signup', mainPage.includes('href="/signup"'));
check('no handleAuth(true) left on the login page', !mainPage.includes('handleAuth(true)'));
check('no signUp call left on the login page', !mainPage.includes('supabase.auth.signUp'));
check('login is login-only (handleLogin)', mainPage.includes('const handleLogin'));

// 5. The Google auto-account note shows under the Google button in
//    both pages.
check('login page shows the Google auto-account note', mainPage.includes('googleCreatesAccount'));
check('signup page shows the Google auto-account note', signupPage.includes('googleCreatesAccount'));

// 6. Every new translation key exists in all three languages.
const newKeys = [
  'signupTitle',
  'creatingAccount',
  'signupFailed',
  'turnstileLoadFailed',
  'googleCreatesAccount',
  'googleFailed',
  'alreadyHaveAccount',
  'backToLogin',
];
for (const key of newKeys) {
  const count = translations.split(`${key}:`).length - 1;
  check(`translation key ${key} exists in 3 languages`, count === 3);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll signup-page smoke checks passed.');
