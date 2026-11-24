import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Deducts one credit from a user, atomically when the `deduct_credit`
 * database function exists (see supabase/migrations/
 * 20261124000000_bookmarks_user_profiles.sql).
 *
 * Returns the new credit balance, or `null` when the user has no credits
 * left (or no profile row). Falls back to an optimistic-concurrency update
 * when the RPC function has not been applied to the database yet, so the
 * route keeps working on databases where the migration was not run.
 */
export async function deductCredit(
  admin: SupabaseClient,
  userId: string,
  currentCredits: number
): Promise<number | null> {
  // Preferred path: one atomic statement in the database.
  try {
    const { data, error } = await admin.rpc('deduct_credit', {
      p_user_id: userId,
    });
    if (!error && typeof data === 'number') return data;
    // PGRST202 = function not found: the migration has not been applied yet.
    if (error && error.code !== 'PGRST202') {
      console.warn('deduct_credit RPC failed, using fallback:', error.message);
    }
  } catch (error) {
    console.warn('deduct_credit RPC failed, using fallback:', error);
  }

  // Fallback: update only when the balance still matches what we read,
  // so two concurrent requests cannot both spend the same credit.
  const { data: updated } = await admin
    .from('user_profiles')
    .update({ credits: currentCredits - 1, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('credits', currentCredits)
    .select('credits')
    .maybeSingle();

  if (updated) return updated.credits as number;

  // The balance changed underneath us (or was already 0): re-read once.
  const { data: profile } = await admin
    .from('user_profiles')
    .select('credits')
    .eq('user_id', userId)
    .maybeSingle();
  const fresh = profile?.credits as number | undefined;
  if (typeof fresh === 'number' && fresh > 0) {
    const { data: retried } = await admin
      .from('user_profiles')
      .update({ credits: fresh - 1, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('credits', fresh)
      .select('credits')
      .maybeSingle();
    if (retried) return retried.credits as number;
  }
  return null;
}
