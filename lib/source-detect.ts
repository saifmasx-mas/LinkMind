// One shared source classifier for the library: the source counts, the
// source filter and the OrbitalHub all derive from the bookmark URL, so
// they must agree. This used to live inline in app/page.tsx; it is a
// module now so the smoke test can import the real function.
//
// LINKEDIN SHORT LINKS (2026-11-26): LinkedIn shares from the app come
// as lnkd.in links. They used to fall through to 'all', so the LinkedIn
// count stayed 0, the galaxy showed no badge, and the card vanished
// under the LinkedIn filter — even though the row was saved (the
// duplicate check proved it). lnkd.in is LinkedIn too.
export type SourceId =
  | 'all'
  | 'youtube'
  | 'pdf'
  | 'word'
  | 'facebook'
  | 'google'
  | 'instagram'
  | 'tiktok'
  | 'linkedin'
  | 'x'
  | 'telegram';

export function detectSource(url: string): SourceId {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (
    u.startsWith('file://pdf/') ||
    u.endsWith('.pdf') ||
    u.includes('/pdf') ||
    u.includes('drive.google.com')
  )
    return 'pdf';
  if (
    u.startsWith('file://word/') ||
    u.startsWith('file://doc/') ||
    u.endsWith('.doc') ||
    u.endsWith('.docx') ||
    u.includes('docs.google.com')
  )
    return 'word';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com'))
    return 'facebook';
  if (u.includes('google.com') || u.includes('goo.gl')) return 'google';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('linkedin.com') || u.includes('lnkd.in')) return 'linkedin';
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x';
  if (u.includes('t.me') || u.includes('telegram')) return 'telegram';
  return 'all';
}
