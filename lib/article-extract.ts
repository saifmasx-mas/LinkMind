// Article text extraction for generic pages (blogs, news, docs).
//
// BLOGGER FETCH FIX (2026-11-26): a Blogger article about Android 17
// (karraraliraqii.blogspot.com) failed live with "contentWarning" — the
// summary was built from the title alone — even though the same page
// fetched locally returns a full article. Local reproduction with the
// exact code from app/api/analyze/route.ts showed the primary
// h1/h2/h3/p/li pass DOES find ~5,400 chars on that page, so the
// extraction selector was not the problem for that article. But Blogger
// templates vary: many put the post body in <div class="post-body">
// blocks separated by <br> instead of <p> tags, so the primary pass can
// come back nearly empty on other Blogger pages. This helper therefore
// falls back, in order, to the full text of the article container, then
// to the JSON-LD articleBody — instead of silently returning a thin
// title-only summary. The JSON-LD must be read BEFORE <script> tags are
// removed, or it is gone.
import * as cheerio from 'cheerio';

const cleanLine = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

export function extractArticleText(html: string): string {
  const $ = cheerio.load(html);

  // JSON-LD articleBody, read before scripts are stripped below.
  let ldText = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item.articleBody === 'string') {
          ldText += `\n${item.articleBody}`;
        }
      }
    } catch {
      // Malformed JSON-LD: ignore it, the other passes still run.
    }
  });

  $('script, style, nav, footer, header').remove();

  // Primary pass: one line per heading / paragraph / list item, so the
  // section splitter in lib/book-summary.ts can find the article's own
  // headings.
  const primary = $('article, main, body')
    .find('h1, h2, h3, p, li')
    .map((_, el) => cleanLine($(el).text()))
    .get()
    .filter(Boolean)
    .join('\n');
  if (primary.trim().length >= 1000) return primary;

  // Fallback 1: the whole article container as plain text. This is what
  // rescues Blogger templates whose post body lives in <div>s, not <p>s.
  const containerText = cleanLine($('article, .post-body, main').text());
  if (containerText.length >= 1000) return containerText;

  // Fallback 2: structured-data articleBody (often truncated by Blogger,
  // but better than a title-only summary).
  if (cleanLine(ldText).length >= 200) return cleanLine(ldText);

  // Last resort: whatever the primary pass found, even if thin.
  return primary || containerText || cleanLine(ldText);
}
