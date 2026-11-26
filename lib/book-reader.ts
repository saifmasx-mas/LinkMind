// Book reader data (lib/book-reader.ts)
//
// Client-safe helpers for the structured book summary: the chapter /
// idea / detail model, the storage envelope, the plain-text fallback
// parser for older items, and the printable book document (used by the
// «تنزيل PDF» button, which prints through the browser so Arabic is
// shaped correctly).
//
// WHY AN ENVELOPE INSTEAD OF A NEW COLUMN: the bookmarks table has no
// structured-chapters column, and a migration cannot be applied to the
// live database from a code deploy. The structured chapters therefore
// travel inside the existing `summary` text column, after a marker
// line. Every reader of a summary (card, search, PDF export, Notion
// copy, «اسأل ذاكرتك» context) strips the envelope first, so old code
// and old rows keep working unchanged. Rows saved before this change
// have no envelope: the reader falls back to parsing their plain-text
// summary back into chapters (see parsePlainSummaryToChapters).

export interface BookIdea {
  /** One main idea of the chapter, 1-2 sentences. */
  text: string;
  /** The detailed summary of this idea, a short paragraph from the chapter text. */
  detail: string;
}

export interface BookChapterData {
  title: string;
  ideas: BookIdea[];
}

// Marker line that separates the human-readable plain-text summary
// from the JSON envelope. It is an HTML comment so that, even if an
// old renderer shows the raw text, it stays invisible in most views.
export const BOOK_CHAPTERS_MARKER = '\n\n<!--BOOK_CHAPTERS_v1-->\n';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function appendBookChapters(summary: string, chapters: BookChapterData[]): string {
  if (!chapters || chapters.length === 0) return summary;
  return `${summary}${BOOK_CHAPTERS_MARKER}${JSON.stringify(chapters)}`;
}

export interface ParsedBookSummary {
  /** The human-readable summary with the envelope stripped. */
  displaySummary: string;
  /** Structured chapters when the envelope is present and valid, else null. */
  chapters: BookChapterData[] | null;
}

function isValidChapterData(value: unknown): value is BookChapterData[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (chapter) =>
      chapter &&
      typeof chapter === 'object' &&
      typeof (chapter as BookChapterData).title === 'string' &&
      Array.isArray((chapter as BookChapterData).ideas) &&
      (chapter as BookChapterData).ideas.every(
        (idea) =>
          idea &&
          typeof idea === 'object' &&
          typeof (idea as BookIdea).text === 'string' &&
          (idea as BookIdea).text.trim().length > 0 &&
          typeof (idea as BookIdea).detail === 'string'
      )
  );
}

export function parseBookSummary(summary: string): ParsedBookSummary {
  const raw = summary || '';
  const markerAt = raw.indexOf(BOOK_CHAPTERS_MARKER);
  if (markerAt === -1) {
    return { displaySummary: raw, chapters: null };
  }
  const displaySummary = raw.slice(0, markerAt).trim();
  const jsonText = raw.slice(markerAt + BOOK_CHAPTERS_MARKER.length).trim();
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (isValidChapterData(parsed)) {
      return { displaySummary, chapters: parsed };
    }
  } catch {
    // Corrupt envelope: fall through and show the plain text.
  }
  return { displaySummary, chapters: null };
}

/** Plain display summary (envelope stripped) for search, export and ask. */
export function stripBookChapters(summary: string): string {
  return parseBookSummary(summary).displaySummary;
}

const BULLET_PREFIX = /^[•\-*]\s*/;

function ideaFromLine(line: string): BookIdea {
  const text = line.replace(BULLET_PREFIX, '').trim();
  return { text, detail: text };
}

// Fallback for rows saved before structured chapters existed: parse
// the plain-text summary ("Title\n• idea\n• idea\n\nTitle2\n• ...")
// back into chapters. An idea without a stored detail shows its own
// text as the detail, so an expandable idea NEVER opens an empty view.
export function parsePlainSummaryToChapters(summary: string): BookChapterData[] {
  const text = (summary || '').trim();
  if (!text) return [];
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const chapters: BookChapterData[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const bulletLines = lines.filter((line) => BULLET_PREFIX.test(line));
    if (bulletLines.length > 0) {
      const titleLine = lines.find((line) => !BULLET_PREFIX.test(line));
      chapters.push({
        title: titleLine || 'ملخص',
        ideas: bulletLines.map(ideaFromLine),
      });
    } else {
      // Prose block with no bullets: one idea carrying the whole block.
      chapters.push({
        title: 'ملخص',
        ideas: [{ text: lines[0].slice(0, 160), detail: lines.join(' ') }],
      });
    }
  }
  if (chapters.length === 0) {
    return [{ title: 'ملخص', ideas: [{ text: text.slice(0, 160), detail: text }] }];
  }
  return chapters;
}

export interface PrintBookOptions {
  title: string;
  chapters: BookChapterData[];
  /** 'ar' | 'tr' | 'en' — controls dir and the fixed labels. */
  lang: string;
  siteName?: string;
  /** Emit the auto-print script (browser use). Off for tests. */
  autoPrint?: boolean;
}

function printLabels(lang: string): {
  subtitle: string;
  chaptersHeading: string;
  chaptersCount: string;
  ideaLabel: string;
  detailLabel: string;
  footer: string;
} {
  if (lang === 'tr') {
    return {
      subtitle: 'Bölüm bölüm tam özet',
      chaptersHeading: 'Bölümler',
      chaptersCount: 'bölüm',
      ideaLabel: 'Fikir',
      detailLabel: 'Ayrıntı',
      footer: 'LinkMind ile oluşturuldu',
    };
  }
  if (lang === 'en') {
    return {
      subtitle: 'Full chapter-by-chapter summary',
      chaptersHeading: 'Chapters',
      chaptersCount: 'chapters',
      ideaLabel: 'Idea',
      detailLabel: 'Detail',
      footer: 'Generated by LinkMind',
    };
  }
  return {
    subtitle: 'ملخص شامل فصلاً بفصل',
    chaptersHeading: 'الفصول',
    chaptersCount: 'فصول',
    ideaLabel: 'الفكرة',
    detailLabel: 'التفصيل',
    footer: 'أُنشئ بواسطة LinkMind',
  };
}

// The printable book document: cover + one section per chapter, each
// idea with its detail underneath. It is plain HTML+CSS (not a binary
// PDF library) on purpose: the browser shapes Arabic correctly, keeps
// RTL order and uses the system's own naskh Arabic font, while binary
// PDF libraries (pdf-lib / jsPDF) draw Arabic letters disconnected
// and in the wrong order because they have no shaping engine — and
// Vercel serverless cannot run Word/LibreOffice. The user saves it as
// PDF from the browser's print dialog («حفظ كملف PDF»), which produces
// a genuine, selectable-text PDF. The original Word layout (fonts,
// images, tables) is NOT preserved: this document is built from the
// extracted text and the AI summary, not from the .docx file itself.
export function buildBookPrintHtml(opts: PrintBookOptions): string {
  const lang = opts.lang || 'ar';
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const labels = printLabels(lang);
  const siteName = opts.siteName || 'LinkMind';
  const today = new Date().toLocaleDateString(lang === 'ar' ? 'ar' : lang === 'tr' ? 'tr' : 'en');

  const chaptersHtml = opts.chapters
    .map((chapter, chapterIndex) => {
      const ideasHtml = chapter.ideas
        .map((idea, ideaIndex) => {
          return `<div class="idea">
          <div class="idea-title"><span class="idea-number">${ideaIndex + 1}</span> ${escapeHtml(idea.text)}</div>
          <p class="idea-detail">${escapeHtml(idea.detail)}</p>
        </div>`;
        })
        .join('\n');
      return `<section class="chapter">
      <h2><span class="chapter-number">${chapterIndex + 1}</span> ${escapeHtml(chapter.title)}</h2>
      ${ideasHtml}
    </section>`;
    })
    .join('\n');

  const autoPrintScript =
    opts.autoPrint === false
      ? ''
      : `<script>
      window.onload = function () {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(function () { window.print(); });
        } else {
          window.print();
        }
      };
    </script>`;

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(opts.title)} - ${escapeHtml(siteName)}</title>
<style>
  * { box-sizing: border-box; }
  /* Arabic font stack: Noto Naskh Arabic (Linux / Android), Traditional
     Arabic (Windows, a proper naskh font), Amiri, then the system UI
     font. No font file is bundled: the push method for this repository
     cannot carry binary files, and every target machine already ships
     a good Arabic font — so the PDF uses the system's own naskh font
     instead of downloading one. */
  body { font-family: 'Noto Naskh Arabic', 'Traditional Arabic', 'Amiri', 'Segoe UI', serif; color: #1e1b4b; line-height: 1.9; padding: 0; margin: 0; }
  @page { size: A4; margin: 18mm 16mm; }
  .cover { text-align: center; padding: 48px 24px 32px; border-bottom: 3px solid #7e22ce; margin-bottom: 28px; }
  .cover .brand { font-size: 15px; font-weight: 700; color: #7e22ce; letter-spacing: 1px; }
  .cover h1 { font-size: 30px; line-height: 1.4; color: #2e1065; margin: 14px 0 8px; }
  .cover .subtitle { font-size: 16px; color: #6b21a8; }
  .cover .meta { font-size: 12px; color: #6b7280; margin-top: 10px; }
  .chapters-heading { font-size: 20px; color: #2e1065; border-bottom: 2px solid #e9d5ff; padding-bottom: 6px; margin: 0 16mm 18px; }
  .chapter { margin: 0 16mm 26px; page-break-inside: avoid; }
  .chapter:first-of-type { page-break-before: avoid; }
  .chapter + .chapter { page-break-before: always; }
  .chapter h2 { font-size: 21px; color: #2e1065; margin: 0 0 12px; line-height: 1.5; }
  .chapter-number { display: inline-block; min-width: 34px; height: 34px; line-height: 34px; text-align: center; border-radius: 50%; background: #7e22ce; color: #fff; font-size: 16px; font-weight: 700; margin-inline-end: 8px; }
  .idea { margin-bottom: 16px; padding: 12px 14px; background: #faf5ff; border-radius: 10px; border-inline-start: 4px solid #9333ea; page-break-inside: avoid; }
  .idea-title { font-weight: 700; color: #3b0764; font-size: 15px; line-height: 1.8; }
  .idea-number { display: inline-block; min-width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 50%; background: #f59e0b; color: #fff; font-size: 13px; font-weight: 700; margin-inline-end: 6px; }
  .idea-detail { font-size: 14px; color: #374151; margin: 6px 0 0; line-height: 1.9; }
  .footer { text-align: center; font-size: 12px; color: #6b7280; border-top: 1px solid #e9d5ff; padding-top: 12px; margin: 30px 16mm 16mm; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="cover">
    <div class="brand">${escapeHtml(siteName)}</div>
    <h1>${escapeHtml(opts.title)}</h1>
    <div class="subtitle">${escapeHtml(labels.subtitle)}</div>
    <div class="meta">${escapeHtml(today)} — ${opts.chapters.length} ${escapeHtml(labels.chaptersCount)}</div>
  </div>
  <h2 class="chapters-heading">${escapeHtml(labels.chaptersHeading)}</h2>
  ${chaptersHtml}
  <div class="footer">${escapeHtml(labels.footer)} — ${escapeHtml(siteName)}</div>
  ${autoPrintScript}
</body>
</html>`;
}
