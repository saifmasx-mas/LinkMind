import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { checkRateLimit, pruneRateLimitBuckets } from '@/lib/rate-limit';
import {
  ADMIN_EMAIL,
  isRecentSignup,
  buildSignupTelegramMessage,
  findAuthUserByEmail,
  NEW_SIGNUP_WINDOW_MS,
} from '@/lib/admin';
import { sendTelegramMessage } from '@/lib/telegram-send';

export const runtime = 'nodejs';

/**
 * POST /api/admin/notify-signup — send the admin an instant Telegram
 * message when somebody registers on LinkMind.
 *
 * Body: { "email": "new-user@example.com" }
 *
 * Called by the browser right after a successful signUp (email +
 * password) or on the first login of a brand-new Google account.
 * It is deliberately unauthenticated — an email-confirmation signup
 * has no session yet — so it verifies the claim with the service-role
 * client instead of trusting the caller:
 *   1. a Supabase Auth user with that email must really exist, and
 *   2. the account must have been created within the last 15 minutes.
 * Anything else gets a silent { ok: true } so the endpoint cannot be
 * used to probe whether an email has an account. One notification per
 * email per hour (rate limit) stops duplicates and spam.
 *
 * The Telegram message goes to the admin's linked chat from the
 * telegram_links table. When the admin has not linked Telegram yet,
 * nothing is sent — the signup still shows up in the admin panel
 * (GET /api/admin/signups), and the panel tells the admin to link
 * Telegram. No new table or migration is needed.
 */

// Best-effort in-memory dedupe so a double-fired client call (or a
// StrictMode double effect) never sends the same signup twice.
const notifiedEmails = new Map<string, number>();

function alreadyNotified(email: string): boolean {
  const now = Date.now();
  const sentAt = notifiedEmails.get(email);
  if (sentAt && now - sentAt < 60 * 60 * 1000) return true;
  notifiedEmails.set(email, now);
  // Keep the map bounded.
  if (notifiedEmails.size > 1_000) {
    for (const [key, at] of notifiedEmails) {
      if (now - at >= 60 * 60 * 1000) notifiedEmails.delete(key);
    }
  }
  return false;
}

export async function POST(request: Request) {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  // Silent ok for bad input too: never confirm or deny anything.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: true });
  }

  pruneRateLimitBuckets();
  const limit = checkRateLimit(`notify-signup:${email}`, 1, 60 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: true });
  }

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    console.error('notify-signup: Supabase admin is not configured');
    return NextResponse.json({ ok: true });
  }

  // 1. The user must really exist in Supabase Auth…
  // (No getUserByEmail in this supabase-js version — findAuthUserByEmail
  // pages through listUsers instead.)
  const newUser = await findAuthUserByEmail(admin.auth.admin, email);
  if (!newUser) {
    return NextResponse.json({ ok: true });
  }

  // 2. …and the account must be brand new (created within the window).
  // This is what makes a replayed or forged call harmless.
  if (!isRecentSignup(newUser.created_at, Date.now(), NEW_SIGNUP_WINDOW_MS)) {
    return NextResponse.json({ ok: true });
  }

  if (alreadyNotified(email)) {
    return NextResponse.json({ ok: true, notified: true });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    console.error('notify-signup: TELEGRAM_BOT_TOKEN is not configured');
    return NextResponse.json({ ok: true, notified: false });
  }

  // The admin's linked Telegram chat. Looked up by the admin's auth
  // user id, resolved from the admin email — never from the request.
  const adminUser = await findAuthUserByEmail(admin.auth.admin, ADMIN_EMAIL);
  if (!adminUser) {
    console.error('notify-signup: admin account not found for', ADMIN_EMAIL);
    return NextResponse.json({ ok: true, notified: false });
  }

  const { data: tgLink, error: linkError } = await admin
    .from('telegram_links')
    .select('chat_id')
    .eq('user_id', adminUser.id)
    .maybeSingle();
  if (linkError) {
    console.error('notify-signup: failed to look up admin Telegram link:', linkError.message);
    return NextResponse.json({ ok: true, notified: false });
  }
  if (!tgLink) {
    console.warn(
      'notify-signup: admin has no linked Telegram chat yet — signup will only show in the admin panel'
    );
    return NextResponse.json({ ok: true, notified: false });
  }

  try {
    await sendTelegramMessage(
      tgLink.chat_id,
      buildSignupTelegramMessage(email, newUser.created_at),
      botToken
    );
  } catch (error) {
    console.error('notify-signup: failed to send Telegram message:', (error as Error).message);
    return NextResponse.json({ ok: true, notified: false });
  }

  return NextResponse.json({ ok: true, notified: true });
}
