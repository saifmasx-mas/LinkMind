// TikTok metadata sources, best first.
//
// REAL-CONTENT FIX (2026-11-26): TikTok's oEmbed answers 200 with NO title
// and NO author_name — an empty success by design, so it can never be the
// content source. The video page itself, however, embeds the real
// description, author, music, hashtags and statistics in the
// __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON block (verified live for
// vt.tiktok.com/ZSs67hEm3/). Fetching that page is now the primary source;
// oEmbed stays only as a fallback to confirm the link exists. No key and
// no cost — but the page needs a mobile User-Agent (the default
// LinkMindBot/1.0 gets a stripped page), and TikTok may intermittently
// serve a captcha page to cloud IPs, so any failure here returns null and
// the caller falls through to the 503 CONTENT_UNAVAILABLE path.

import { fetchPublicUrl } from './safe-fetch';

export interface TikTokMetadata {
  title: string; // the video description, truncated for display
  description: string; // full description
  author: string; // uniqueId, e.g. mmm098646
  authorNickname: string;
  musicTitle: string;
  tags: string[];
  playCount: number;
  likeCount: number;
  commentCount: number;
  source: 'page';
}

export interface TikTokOEmbed {
  title: string;
  authorName: string;
  authorUniqueId: string;
  thumbnailUrl: string;
}

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

// The rehydration JSON is deeply nested and its path may shift, so search
// recursively for the video struct: an object with a string `desc` and an
// `author` object carrying a string `uniqueId`.
function findVideoStruct(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const obj = node as Record<string, unknown>;
  if (
    typeof obj.desc === 'string' &&
    obj.author &&
    typeof obj.author === 'object' &&
    typeof (obj.author as Record<string, unknown>).uniqueId === 'string'
  ) {
    return obj;
  }
  for (const value of Object.values(obj)) {
    const found = findVideoStruct(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Fetch real metadata from the video page's embedded JSON. Returns null
 * when the page is a captcha/consent page, the data block is missing or
 * unparseable, or the request fails — the caller falls back to oEmbed,
 * never throws.
 */
export async function fetchTikTokPageMetadata(
  videoUrl: string
): Promise<TikTokMetadata | null> {
  try {
    const res = await fetchPublicUrl(videoUrl, 0, { userAgent: MOBILE_USER_AGENT });
    if (res.status < 200 || res.status >= 300) {
      console.error(
        '[tiktok] video page request failed with HTTP status',
        res.status
      );
      return null;
    }
    return parseTikTokPageHtml(res.body.toString('utf8'));
  } catch (error) {
    console.error(
      '[tiktok] video page fetch failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return null;
  }
}

/**
 * Pure parser for a TikTok video page's HTML (exported for testing).
 * Extracts the __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON block and reads
 * the video struct from it. Returns null for captcha/consent pages
 * (no data block), unparseable JSON, or a missing video struct.
 */
export function parseTikTokPageHtml(html: string): TikTokMetadata | null {
  const marker = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null; // captcha / consent page: no data block
  const tagEnd = html.indexOf('>', markerIdx);
  const scriptEnd = tagEnd === -1 ? -1 : html.indexOf('</script>', tagEnd);
  if (tagEnd === -1 || scriptEnd === -1) return null;
  let data: unknown;
  try {
    data = JSON.parse(html.slice(tagEnd + 1, scriptEnd).trim());
  } catch {
    return null;
  }
  const item = findVideoStruct(data);
  if (!item) return null;
  const description =
    typeof item.desc === 'string' ? item.desc.trim() : '';
  if (!description) return null;
  const author = (item.author ?? {}) as Record<string, unknown>;
  const music = (item.music ?? {}) as Record<string, unknown>;
  const stats = (item.stats ?? {}) as Record<string, unknown>;
  const textExtra = Array.isArray(item.textExtra) ? item.textExtra : [];
  const tags = textExtra
    .map((entry) => (entry as Record<string, unknown>)?.hashtagName)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return {
    title:
      description.length > 120 ? `${description.slice(0, 117)}…` : description,
    description,
    author: typeof author.uniqueId === 'string' ? author.uniqueId : '',
    authorNickname: typeof author.nickname === 'string' ? author.nickname : '',
    musicTitle: typeof music.title === 'string' ? music.title : '',
    tags,
    playCount: toNumber(stats.playCount),
    likeCount: toNumber(stats.diggCount),
    commentCount: toNumber(stats.commentCount),
    source: 'page',
  };
}

/**
 * oEmbed fallback: confirms the link exists and, on the rare occasions it
 * carries a title, supplies it. Returns null when the response is empty
 * (the usual case) or fails — never throws.
 */
export async function fetchTikTokOEmbed(
  videoUrl: string
): Promise<TikTokOEmbed | null> {
  try {
    const res = await fetchPublicUrl(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`,
      0,
      { accept: 'application/json' }
    );
    if (res.status < 200 || res.status >= 300) {
      console.error(
        '[tiktok] oEmbed request failed with HTTP status',
        res.status
      );
      return null;
    }
    const data = JSON.parse(res.body.toString('utf8'));
    const title = typeof data?.title === 'string' ? data.title.trim() : '';
    if (!title) return null;
    return {
      title,
      authorName: typeof data?.author_name === 'string' ? data.author_name : '',
      authorUniqueId:
        typeof data?.author_unique_id === 'string' ? data.author_unique_id : '',
      thumbnailUrl:
        typeof data?.thumbnail_url === 'string' ? data.thumbnail_url : '',
    };
  } catch (error) {
    console.error(
      '[tiktok] oEmbed fetch failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return null;
  }
}
