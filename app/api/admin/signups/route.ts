import { NextResponse } from 'next/server';
import { getAuthenticatedUserId } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { checkRateLimit, pruneRateLimitBuckets } from '@/lib/rate-limit';
import { ADMIN_EMAIL, isAdminEmail, RECENT_SIGNUPS_LIMIT } from '@/lib/admin';

export const runtime = 'nodejs';

/**
 * GET /api/admin/signups — latest registered users, admin only.
 *
 * The admin (Saif) asked to see new signups inside the site itself
 * instead of opening Supabase. The caller is verified on the server:
 * the Bearer token must belong to the admin email. Everyone else gets
 * 403 and learns nothing — not even whether the route exists.
 *
 * Only email + registration date are returned, never anything else
 * about a user. The list comes from Supabase Auth (service-role
 * client), so it includes users who signed up with email/password
 * AND with Google, whether or not they ever opened the app again.
 * No new table or migration is needed.
 */
export async function GET(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  pruneRateLimitBuckets();
  const limit = checkRateLimit(`admin-signups:${userId}`, 30, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 });
  }

  // Verify the caller really is the admin, by email, on the server.
  const { data: caller, error: callerError } = await admin.auth.admin.getUserById(userId);
  if (callerError || !caller?.user || !isAdminEmail(caller.user.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // List users newest first. listUsers pages through auth.users; 50 per
  // page is more than the panel shows, so one page is enough.
  const { data: list, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 50,
  });
  if (listError) {
    console.error('Failed to list users for admin panel:', listError.message);
    return NextResponse.json({ error: 'Could not load signups' }, { status: 500 });
  }

  const signups = (list?.users ?? [])
    .map((u) => ({ email: u.email ?? '', created_at: u.created_at }))
    .filter((s) => s.email)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, RECENT_SIGNUPS_LIMIT);

  // Does the admin have Telegram linked? The panel shows a hint to link
  // it when not, because the instant notification needs that link.
  const { data: tgLink } = await admin
    .from('telegram_links')
    .select('chat_id')
    .eq('user_id', userId)
    .maybeSingle();

  return NextResponse.json({
    signups,
    total: list?.users?.length ?? signups.length,
    telegramLinked: Boolean(tgLink),
    adminEmail: ADMIN_EMAIL,
  });
}
