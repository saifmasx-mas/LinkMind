import type { NextConfig } from 'next';

// SECURITY (2026-11-24 audit): the app shipped with no security headers at
// all. These are basic, safe defaults:
// - frame-ancestors 'none' (+ X-Frame-Options DENY) stops clickjacking.
// - nosniff stops the browser guessing a wrong content type.
// - A limited CSP: scripts/styles need 'unsafe-inline' because Next.js
//   emits inline scripts and the app uses inline styles; external images
//   (YouTube thumbnails, og:image) and Supabase/Telegram connections are
//   allowed explicitly. Tighten this further once no inline code remains.
// - Cloudflare Turnstile (2026-11-25): the "are you a robot" widget loads
//   its script, iframe and verification requests from
//   https://challenges.cloudflare.com, so that origin is allowed in
//   script-src, frame-src and connect-src. Without it the browser blocks
//   the widget and the login page shows an empty space instead of the
//   human check (PR #2 regression).
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co https://api.telegram.org https://www.youtube.com https://challenges.cloudflare.com",
              "frame-src https://challenges.cloudflare.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
