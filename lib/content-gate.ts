// CONTENT GATE (2026-11-26): one shared "is there real content?" decision
// for every link-save path (the website /api/analyze and the Telegram bot).
//
// History: PR #6 (2026-11-25) stopped invented summaries when a fetch
// failed — but its gate covered YouTube, TikTok and (later, PR #17)
// LinkedIn only. A general article/blog page whose fetch failed still
// reached Gemini as a bare URL and came back as an invented summary that
// was saved and charged for. The Telegram bot save path had no gate at
// all. Both paths now ask this one function before any Gemini call, save
// or credit deduction.
//
// "Real content" is deliberately narrow: a genuine title, a genuine
// description, a real transcript, or real body text fetched from the
// source. The bare URL is never content. A page that returns a title but
// no body still passes (metadata-only summary, with the contentWarning
// shown to the user) — only a page with nothing real at all is refused.

export type LinkKind = 'youtube' | 'tiktok' | 'linkedin' | 'general';

export interface FetchedLinkContent {
  /** Which source the link is — the rule differs per kind. */
  kind: LinkKind;
  /** The fetch stage failed outright (network error, non-2xx status, non-HTML). */
  fetchFailed: boolean;
  /** A genuine title fetched from the source (API / oEmbed / og:title). Never the bare URL. */
  hasRealTitle: boolean;
  /** A genuine description fetched from the source (API / page description). */
  hasRealDescription: boolean;
  /** A real YouTube transcript was fetched. */
  hasTranscript: boolean;
  /** Length in characters of real body text extracted from the page (0 when none was extracted). */
  bodyTextLength: number;
  /** The fetched title (used to recognise login walls). */
  title: string;
}

// A fetched page needs at least this much body text to count as real
// content on its own (mirrors the <80-char book-text gate in /api/analyze).
const MIN_BODY_TEXT_CHARS = 80;

/** True when the fetched title is a generic login-wall title, not a post title. */
export function isLoginWallTitle(title: string): boolean {
  const wallTitle = title.trim().toLowerCase();
  return (
    wallTitle === 'linkedin' ||
    wallTitle.startsWith('sign up') ||
    /^(log ?in|sign ?in)( \| linkedin)?$/.test(wallTitle)
  );
}

/**
 * True when the fetch stage brought back real content worth summarising.
 * False means the caller must fail fast with 503 CONTENT_UNAVAILABLE —
 * no Gemini call, no save, no credit deduction.
 */
export function hasRealLinkContent(content: FetchedLinkContent): boolean {
  switch (content.kind) {
    case 'youtube':
      // A transcript, a real title or a real description is enough —
      // the summary is then built from the metadata alone.
      return content.hasTranscript || content.hasRealTitle || content.hasRealDescription;
    case 'tiktok':
      return content.hasRealTitle || content.hasRealDescription;
    case 'linkedin': {
      // LinkedIn requires login: a failed fetch, a wall title, or a page
      // with no body text at all is never a real post.
      if (content.fetchFailed) return false;
      if (isLoginWallTitle(content.title)) return false;
      return content.bodyTextLength > 0;
    }
    case 'general': {
      // NEW (2026-11-26): a failed fetch means nothing real was brought
      // back — the bare URL must never reach Gemini. A page that fetched
      // fine counts when it has a real title, a real description, or
      // substantial body text.
      if (content.fetchFailed) return false;
      return (
        content.hasRealTitle ||
        content.hasRealDescription ||
        content.bodyTextLength >= MIN_BODY_TEXT_CHARS
      );
    }
  }
  // Unreachable for a valid LinkKind — refuse by default, never invent.
  return false;
}
