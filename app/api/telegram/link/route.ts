import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const authorization = request.headers.get('authorization');
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 });
  }

  const authClient = createClient(supabaseUrl, anonKey);
  const { data, error: authError } = await authClient.auth.getUser(accessToken);
  if (authError || !data.user) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
  if (!botUsername || !/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) {
    return NextResponse.json({ error: 'Telegram bot is not configured' }, { status: 503 });
  }

  try {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const admin = createSupabaseAdminClient();
    const { error: insertError } = await admin.from('telegram_link_tokens').insert({
      token_hash: tokenHash,
      user_id: data.user.id,
      expires_at: expiresAt,
    });

    if (insertError) {
      console.error('Failed to create Telegram link token:', insertError.message);
      return NextResponse.json({ error: 'Could not create Telegram link' }, { status: 500 });
    }

    return NextResponse.json(
      { url: `https://t.me/${botUsername}?start=${token}` },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Telegram link setup failed:', error);
    return NextResponse.json({ error: 'Telegram link is unavailable' }, { status: 503 });
  }
}
