/**
 * Admin helpers for the new-signup notification feature (2026-11-26).
 *
 * The admin is a single account, identified by email. The address is the
 * site owner's (Saif) and can be overridden with the ADMIN_EMAIL env var
 * without a code change. Nothing here is secret: the admin check itself
 * always happens on the server (see /api/admin/*) — the browser only ever
 * sees the list after the server has verified the caller is the admin.
 */

// The site owner's account. Overridable via env var, same address by default.
export const ADMIN_EMAIL: string = (
  process.env.ADMIN_EMAIL?.trim() || 'saif.masx@gmail.com'
).toLowerCase();

// How many of the newest signups the admin panel shows.
export const RECENT_SIGNUPS_LIMIT = 20;

// A signup only counts as "new" for the instant Telegram notification
// when the auth account was created this recently. This stops the
// /api/admin/notify-signup endpoint from being replayed later to spam
// the admin about old accounts.
export const NEW_SIGNUP_WINDOW_MS = 15 * 60 * 1000;

export function isAdminEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.trim().toLowerCase() === ADMIN_EMAIL;
}

/** True when `createdAt` (ISO string from Supabase Auth) is within the new-signup window. */
export function isRecentSignup(
  createdAt: string,
  nowMs: number = Date.now(),
  windowMs: number = NEW_SIGNUP_WINDOW_MS
): boolean {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return false;
  return createdMs <= nowMs && nowMs - createdMs <= windowMs;
}

/**
 * Plain-text Telegram message for a purchase intent (2026-11-26).
 * Sent to the admin when a Telegram user tells the support bot they
 * want to buy or pick a plan. The bot never handles payment itself —
 * the owner steps in personally — so the message carries the buyer's
 * exact words and the chat id (in case the owner wants to find the
 * conversation), plus the time. Plain text (no parse_mode), so the
 * buyer message needs no escaping.
 */
export function buildPurchaseIntentTelegramMessage(
  buyerMessage: string,
  buyerChatId: number,
  whenMs: number = Date.now()
): string {
  const when = new Date(whenMs);
  const whenText = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleString('ar', { timeZone: 'Asia/Riyadh' });
  return (
    `🛒 نية شراء جديدة في LinkMind\n\n` +
    `💬 رسالة المشتري:\n${buyerMessage}\n\n` +
    `🆔 المحادثة: ${buyerChatId}` +
    (whenText ? `\n🕒 ${whenText}` : '')
  );
}

/**
 * Plain-text Telegram message for a new signup. Sent as plain text
 * (no parse_mode), so the email address needs no escaping.
 */
export function buildSignupTelegramMessage(email: string, createdAt: string): string {
  const when = new Date(createdAt);
  const whenText = Number.isNaN(when.getTime())
    ? createdAt
    : when.toLocaleString('ar', { timeZone: 'Asia/Riyadh' });
  return `🆕 تسجيل جديد في LinkMind\n\n📧 ${email}\n🕒 ${whenText}`;
}

export interface AdminUserRecord {
  id: string;
  email?: string;
  created_at: string;
}

/**
 * Minimal shape of the Supabase Auth admin client we need. Declared
 * structurally (instead of importing the Supabase types) so this file
 * stays dependency-free and unit-testable on its own.
 */
export interface AuthUserLister {
  listUsers(params: { page: number; perPage: number }): Promise<{
    data: { users: AdminUserRecord[] } | null;
    error: { message: string } | null;
  }>;
}

/**
 * Find one auth user by email. This supabase-js version has no
 * getUserByEmail, so we page through listUsers (100 per page, capped
 * at 5 pages — far above this project's user count) and match the
 * email case-insensitively.
 */
export async function findAuthUserByEmail(
  lister: AuthUserLister,
  email: string
): Promise<AdminUserRecord | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await lister.listUsers({ page, perPage: 100 });
    if (error || !data) return null;
    const found = data.users.find((u) => (u.email ?? '').toLowerCase() === wanted);
    if (found) return found;
    if (data.users.length < 100) break;
  }
  return null;
}
