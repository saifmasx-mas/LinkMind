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
//
// BLOGGER (2026-11-27): same shape of bug for Blogger. The card badge
// (isBloggerUrl in app/page.tsx) already recognised blogspot.com /
// blogger.com, but this classifier did not, so the three saved Blogger
// articles fell through to 'all': no Blogger count, no Blogger filter
// in the Galaxy. blogspot. / blogger.com is Blogger here.
export type SourceId =
  | 'all'
  | 'youtube'
  | 'pdf'
  | 'word'
  | 'facebook'
  | 'google'
  | 'blogger'
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
  // BLOGGER (2026-11-27): blogspot.com / blogger.com articles are a
  // source of their own. They used to fall through to 'all', so the
  // library never counted them as Blogger and the Galaxy showed no
  // Blogger filter — even though the card badge (isBloggerUrl, same
  // rule) was already showing. Checked after 'google' so a Google
  // search link that merely mentions blogspot stays Google; a real
  // blogspot URL never contains 'google.com'. 'blogspot.' (with the
  // dot) also covers country variants like blogspot.co.uk.
  if (u.includes('blogspot.') || u.includes('blogger.com')) return 'blogger';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('linkedin.com') || u.includes('lnkd.in')) return 'linkedin';
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x';
  if (u.includes('t.me') || u.includes('telegram')) return 'telegram';
  return 'all';
}
