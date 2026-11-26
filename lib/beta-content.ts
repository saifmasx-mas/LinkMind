// BETA / FAST-CHANGING CONTENT MARKER (2026-11-27): a saved item
// about beta / pre-release content gets a small amber «محتوى تجريبي»
// badge on its card, so the reader knows the details may change with
// updates. Detection is render-time (URL + title + summary), like the
// Blogger badge — the Android 17 beta article gets the badge
// automatically, no re-paste, no migration.
//
// STRICTNESS: the rule must not misfire on ordinary articles, so the
// keywords are split in two tiers:
//   - STRONG (beta / بيتا / تجريبي): counts in the title, the URL or
//     the summary. These words almost always mean pre-release content.
//   - WEAK (preview / pre-release / experimental): counts ONLY in the
//     title or the URL. A passing mention in the summary — e.g. a
//     science article about "experimental results" — must not badge
//     the card.
// English keywords are matched with word boundaries, so "alphabet"
// never matches "beta". "Beta-blockers" (the medicine) is excluded
// explicitly: a cardiology article is not beta software.

const STRONG_KEYWORDS: RegExp[] = [/\bbeta\b/i, /بيتا/, /تجريبي/];
const WEAK_TITLE_URL_KEYWORDS: RegExp[] = [
  /\bpreview\b/i,
  /\bpre[-\s]?release\b/i,
  /\bexperimental\b/i,
];
const EXCLUSIONS: RegExp[] = [/\bbeta[-\s]?blockers?\b/i, /حاصرات بيتا/];

export function isBetaContent(input: {
  url?: string;
  title?: string;
  summary?: string;
}): boolean {
  const title = (input.title ?? '').trim();
  const url = (input.url ?? '').trim();
  const summary = (input.summary ?? '').trim();
  if (!title && !url && !summary) return false;

  const titleUrl = `${title} ${url}`;
  const allText = `${titleUrl} ${summary}`;

  // A medicine article about beta-blockers is not beta software.
  if (EXCLUSIONS.some((re) => re.test(allText))) return false;

  // Strong keywords: title, URL or summary.
  if (STRONG_KEYWORDS.some((re) => re.test(allText))) return true;

  // Weak keywords: title or URL only — never the summary alone.
  if (WEAK_TITLE_URL_KEYWORDS.some((re) => re.test(titleUrl))) return true;

  return false;
}
