// YouTube metadata sources, best first.
//
// REAL-CONTENT FIX (2026-11-26): the old fetch stage had only two YouTube
// sources — oEmbed (which fails from Vercel IPs) and the transcript (which
// is impossible for videos with no captions at all, e.g. the nasheed
// yLESNXK7_44). A video with neither ended in the 503 CONTENT_UNAVAILABLE
// path, which is a correct safety net but not a working feature. The
// official YouTube Data API v3 is now the primary source: videos.list
// returns the real title, full description, channel, tags and duration
// regardless of Vercel IPs, at 1 quota unit per call out of a free
// 10,000 units/day — far more than this project needs. oEmbed stays as a
// fallback (it also supplies the thumbnail), and the transcript is still
// attempted in parallel for videos that do have captions.
//
// The API key is optional: without YOUTUBE_API_KEY the API call is skipped
// and the old oEmbed + transcript behaviour applies unchanged.

import { fetchPublicUrl } from './safe-fetch';

export interface YouTubeMetadata {
  title: string;
  description: string;
  channelTitle: string;
  tags: string[];
  duration: string; // ISO 8601, e.g. PT9M4S
  source: 'api' | 'oembed';
}

export interface YouTubeOEmbed {
  title: string;
  authorName: string;
  thumbnailUrl: string;
}

/**
 * Fetch title/description/channel/tags/duration from YouTube Data API v3.
 * Returns null when there is no key, the video is missing, the quota is
 * exhausted (403), or the request fails for any other reason — the caller
 * falls back to oEmbed, never throws.
 */
export async function fetchYouTubeApiMetadata(
  videoId: string,
  apiKey: string | undefined
): Promise<YouTubeMetadata | null> {
  if (!apiKey) return null;
  try {
    const res = await fetchPublicUrl(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(
        videoId
      )}&key=${encodeURIComponent(apiKey)}`,
      0,
      { accept: 'application/json' }
    );
    if (res.status < 200 || res.status >= 300) return null;
    return parseYouTubeApiResponse(JSON.parse(res.body.toString('utf8')));
  } catch {
    return null;
  }
}

/** Pure parser for a videos.list response (exported for testing). */
export function parseYouTubeApiResponse(data: unknown): YouTubeMetadata | null {
  const item = (data as Record<string, unknown> | null)?.items as
    | unknown[]
    | undefined;
  const first = Array.isArray(item) ? item[0] : null;
  if (!first || typeof first !== 'object') return null;
  const snippet = (first as Record<string, unknown>).snippet as
    | Record<string, unknown>
    | undefined;
  if (!snippet || typeof snippet !== 'object') return null;
  const title = typeof snippet.title === 'string' ? snippet.title.trim() : '';
  if (!title) return null;
  const contentDetails = (first as Record<string, unknown>).contentDetails as
    | Record<string, unknown>
    | undefined;
  return {
    title,
    description:
      typeof snippet.description === 'string' ? snippet.description.trim() : '',
    channelTitle:
      typeof snippet.channelTitle === 'string' ? snippet.channelTitle : '',
    tags: Array.isArray(snippet.tags)
      ? snippet.tags.filter((t: unknown): t is string => typeof t === 'string')
      : [],
    duration:
      contentDetails && typeof contentDetails.duration === 'string'
        ? contentDetails.duration
        : '',
    source: 'api',
  };
}

/**
 * Fallback metadata from oEmbed: real title + author + thumbnail when it
 * answers. Returns null on any failure (including the empty 200s Vercel
 * IPs sometimes get) — the caller falls back to the API result or the
 * 503 path, never throws.
 */
export async function fetchYouTubeOEmbed(
  videoUrl: string
): Promise<YouTubeOEmbed | null> {
  try {
    const res = await fetchPublicUrl(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      0,
      { accept: 'application/json' }
    );
    if (res.status < 200 || res.status >= 300) return null;
    return parseYouTubeOEmbedResponse(JSON.parse(res.body.toString('utf8')));
  } catch {
    return null;
  }
}

/** Pure parser for an oEmbed response (exported for testing). */
export function parseYouTubeOEmbedResponse(data: unknown): YouTubeOEmbed | null {
  const obj = data as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (!title) return null;
  return {
    title,
    authorName: typeof obj.author_name === 'string' ? obj.author_name : '',
    thumbnailUrl:
      typeof obj.thumbnail_url === 'string' ? obj.thumbnail_url : '',
  };
}
