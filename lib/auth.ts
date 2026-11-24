import { createClient } from '@supabase/supabase-js';

/**
 * Returns the authenticated user's id from a `Authorization: Bearer <token>`
 * header, or `null` when the request carries no valid Supabase session.
 * API routes must never trust a `userId` sent in the request body.
 */
export async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  const authorization = req.headers.get('authorization');
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anonKey) return null;

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user.id;
}
