import { NextResponse } from 'next/server';
import { checkRateLimit, pruneRateLimitBuckets } from '@/lib/rate-limit';

// Cloudflare Turnstile (2026-11-24): the login page proves the visitor is
// human with a Turnstile token; this route is the only place that checks
// it. The secret key lives in TURNSTILE_SECRET_KEY on the server and is
// never sent to the browser, logged, or written anywhere else.
export async function POST(req: Request) {
  try {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
      return NextResponse.json(
        { error: 'Service is not configured' },
        { status: 503 }
      );
    }

    const { token } = (await req.json().catch(() => ({}))) as {
      token?: unknown;
    };
    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    // A token check is cheap, but an attacker could still hammer this
    // route to burn Cloudflare verifications, so rate limit per IP.
    pruneRateLimitBuckets();
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const limit = checkRateLimit(`verify-turnstile:${ip}`, 20, 60_000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: {
            'Retry-After': String(
              Math.ceil((limit.resetAt - Date.now()) / 1000)
            ),
          },
        }
      );
    }

    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', token);

    const verifyRes = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: form }
    );
    if (!verifyRes.ok) {
      console.error('Turnstile siteverify request failed:', verifyRes.status);
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 502 }
      );
    }

    const result = (await verifyRes.json()) as {
      success?: boolean;
      'error-codes'?: string[];
    };
    if (!result.success) {
      // Cloudflare's error codes stay in the server log only; the client
      // gets a generic "no" so nothing about the check leaks.
      console.warn(
        'Turnstile verification rejected:',
        result['error-codes']
      );
      return NextResponse.json({ success: false });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Verify Turnstile Error:', error);
    return NextResponse.json(
      { error: 'Verification failed' },
      { status: 500 }
    );
  }
}
