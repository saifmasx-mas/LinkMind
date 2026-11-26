import { GoogleGenAI, Type } from '@google/genai';
import { generateContentWithFallback } from './gemini';

// FULL-BOOK SUMMARY (2026-11-26): when a book/article is uploaded, the
// site used to send only the first ~14,000 characters to Gemini with a
// "3-sentence summary of the core thesis" prompt, so the result covered
// only the most important ideas of the beginning of the book. The feature
// requested is a COMPREHENSIVE summary of the WHOLE text — every main
// idea, organised chapter by chapter (or section by section for
// articles), so a student can study from it without reading the whole
// thing. Long articles pasted as links (a blog such as Blogger, or any
// other article page) use this same path with kind: 'article'; videos
// and short social posts keep the single-call short summary.
//
// How it works:
// 1. splitBookIntoChapters() finds the book's own chapter headings
//    (الفصل/الباب/المبحث/المقدمة/الخاتمة, numbered headings, "Chapter N",
//    or short standalone lines followed by a long paragraph). When the
//    text has no usable headings it falls back to inline "الفصل X"
//    markers, then to even size-based sections.
// 2. summarizeBookFull() summarises every chapter with Gemini IN
//    PARALLEL (one call per chapter, each with the usual model fallback
//    chain from lib/gemini.ts), then joins the per-chapter results into a
//    single plain-text summary with one block per chapter.
// 3. The route saves that combined text as the bookmark summary, and
//    the per-chapter key ideas (up to 2 per chapter) become the checklist
//    the card already shows in a scrollable list.
//
// Time budget (same rules as PR #5 / PR #6): the chapter calls run in
// parallel, so the wall clock is the slowest call, not the sum. The
// Vercel function allows 60s and the frontend aborts at 55s; a failed
// chapter is retried once only while the request is still young
// (< 25s). If any chapter still fails, the whole analysis fails fast
// with AI_UNAVAILABLE and NO credit is deducted — a partial "full"
// summary would be worse than an honest error, because the student
// would trust it to be complete.

export interface BookChapter {
  title: string;
  text: string;
}

// A book is at most this long after the frontend cap (200,000 chars);
// 10 chapters x 30,000 chars covers a whole typical book. Longer books
// are covered up to this total — see the known limits in the PR.
export const MAX_BOOK_TEXT_CHARS = 200_000;
export const MAX_CHAPTERS = 10;
export const MAX_CHAPTER_CHARS = 30_000;
const MIN_CHAPTER_CHARS = 1_000;
const MAX_IDEAS_PER_CHAPTER = 8;
const MAX_CHECKLIST_ITEMS = 12;
const RETRY_DEADLINE_MS = 25_000;

const ARABIC_ORDINALS =
  'الأول|الثاني|الثالث|الرابع|الخامس|السادس|السابع|الثامن|التاسع|العاشر|' +
  'الحادي عشر|الثاني عشر|الأولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|' +
  'السابعة|الثامنة|التاسعة|العاشرة';

const CHAPTER_WORDS = 'الفصل|الباب|المبحث|المطلب|المقدمة|الخاتمة|التمهيد|الفاتحة|القسم|الجزء';

// A heading that repeats identically this many times (or more) is the
// book's RUNNING HEADER, not a chapter start: in the OCR text of
// «اللغة الشاعرة» the book title «اللغة الشاعرة» is printed at the top
// of (nearly) every page, so it looks like a heading dozens of times.
// Dropping those lines keeps the split from exploding into dozens of
// one-page "chapters" and crowding out the real chapters. The content
// is NOT lost — it stays inside the surrounding chapter; only the
// chapter title is imperfect for that stretch of the book.
const RUNNING_HEADER_MAX_OCCURRENCES = 5;

// Normalise Arabic for title comparison: OCR variants of the same title
// (e.g. «الشعر العربي» vs «الشعر العريى») must compare equal.
function normalizeHeading(title: string): string {
  return title
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

function genericSectionTitle(index: number, lang: string): string {
  return lang === 'ar' ? `القسم ${index + 1}` : `Section ${index + 1}`;
}

function looksLikeHeading(line: string, nextLine: string | undefined): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 70) return false;
  // Explicit chapter/part words: الفصل الأول، الباب الثاني، المقدمة، الخاتمة...
  if (new RegExp(`^(${CHAPTER_WORDS})\\b`).test(t)) return true;
  if (/^(Chapter|Part|Section)\s+\d+/i.test(t)) return true;
  // Numbered heading: "1. المقدمة" / "(2) لغة التعبير" / "3- الشعر"
  if (/^[\(]?\d{1,2}[\)\].:—-]\s+\S/.test(t)) return true;
  // Short standalone line with no sentence-ending punctuation, followed
  // by a long paragraph — the shape of a real book heading (e.g. the
  // chapter titles of «اللغة الشاعرة»: "لغة التعبير"، "الشعر ديوان العرب").
  // The "long next line" guard keeps short verse lines in poetry books
  // from being mistaken for headings.
  if (
    t.length <= 45 &&
    !/[.!؟:؛]$/.test(t) &&
    nextLine !== undefined &&
    nextLine.trim().length > 200
  ) {
    return true;
  }
  return false;
}

function truncateChapter(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_CHAPTER_CHARS) return t;
  const cut = t.slice(0, MAX_CHAPTER_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_CHAPTER_CHARS * 0.8 ? cut.slice(0, lastSpace) : cut).trim();
}

function mergeTinyChapters(chapters: BookChapter[]): BookChapter[] {
  const merged: BookChapter[] = [];
  for (const chapter of chapters) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < MIN_CHAPTER_CHARS) {
      // A tiny chapter (e.g. a one-paragraph introduction) joins the
      // next chapter instead of spending a whole Gemini call on it.
      last.text = `${last.text}\n${chapter.text}`.trim();
    } else if (chapter.text.length < MIN_CHAPTER_CHARS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.text = `${prev.text}\n${chapter.text}`.trim();
    } else {
      merged.push({ ...chapter });
    }
  }
  return merged;
}

function mergeDownToMax(chapters: BookChapter[]): BookChapter[] {
  const list = [...chapters];
  while (list.length > MAX_CHAPTERS) {
    // Merge the smallest chapter into its smaller neighbour.
    let smallest = 0;
    for (let i = 1; i < list.length; i++) {
      if (list[i].text.length < list[smallest].text.length) smallest = i;
    }
    if (smallest === 0) {
      list[1].text = `${list[0].text}\n${list[1].text}`.trim();
      list.splice(0, 1);
    } else {
      const into = list[smallest - 1].text.length <= (list[smallest + 1]?.text.length ?? Infinity)
        ? smallest - 1
        : smallest + 1;
      if (into < smallest) {
        list[into].text = `${list[into].text}\n${list[smallest].text}`.trim();
      } else {
        list[into].text = `${list[smallest].text}\n${list[into].text}`.trim();
      }
      list.splice(smallest, 1);
    }
  }
  return list;
}

// Merge chapters that share a title back-to-back: a chapter heading
// that also serves as the running header inside its own chapter (e.g.
// «الزمن في اللغة العربية» printed at the top of its pages) splits one
// real chapter into several same-titled pieces — join them again.
function mergeAdjacentSameTitle(chapters: BookChapter[]): BookChapter[] {
  const merged: BookChapter[] = [];
  for (const chapter of chapters) {
    const last = merged[merged.length - 1];
    if (last && normalizeHeading(last.title) === normalizeHeading(chapter.title)) {
      last.text = `${last.text}\n${chapter.text}`.trim();
    } else {
      merged.push({ ...chapter });
    }
  }
  return merged;
}

function finalizeChapters(chapters: BookChapter[]): BookChapter[] {
  return mergeDownToMax(mergeAdjacentSameTitle(mergeTinyChapters(chapters))).map(
    (c) => ({ title: c.title, text: truncateChapter(c.text) })
  );
}

// Split on explicit "الفصل X" / "الباب X" markers inside flat text (PDF
// text extraction joins a page into one line, so headings often survive
// only as inline markers). Returns null when fewer than 2 markers exist.
function splitOnInlineMarkers(text: string): BookChapter[] | null {
  const marker = new RegExp(
    `(${CHAPTER_WORDS})\\s+(${ARABIC_ORDINALS}|\\d{1,2})`,
    'g'
  );
  const matches = [...text.matchAll(marker)];
  if (matches.length < 2) return null;
  const chapters: BookChapter[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const body = text.slice(start, end).trim();
    // Title = the marker plus the next few words (the heading text).
    const after = body.slice(matches[i][0].length).trim();
    const titleWords = after.split(/\s+/).slice(0, 6).join(' ');
    const title = `${matches[i][0]} ${titleWords}`.replace(/[.!؟:؛]+$/, '').trim();
    chapters.push({ title: title || matches[i][0], text: body });
  }
  return chapters;
}

function splitIntoSizeSections(text: string, lang: string): BookChapter[] {
  const SECTION_CHARS = 8_000;
  const sections: BookChapter[] = [];
  let rest = text.trim();
  let index = 0;
  while (rest.length > 0) {
    if (rest.length <= SECTION_CHARS) {
      sections.push({ title: genericSectionTitle(index, lang), text: rest });
      break;
    }
    const cut = rest.slice(0, SECTION_CHARS);
    // Prefer a sentence boundary near the end of the chunk.
    const boundary = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('. '),
      cut.lastIndexOf('؟ '),
      cut.lastIndexOf('! ')
    );
    const splitAt = boundary > SECTION_CHARS * 0.6 ? boundary + 1 : cut.lastIndexOf(' ');
    const take = splitAt > 0 ? splitAt : SECTION_CHARS;
    sections.push({
      title: genericSectionTitle(index, lang),
      text: rest.slice(0, take).trim(),
    });
    rest = rest.slice(take).trim();
    index++;
  }
  return sections;
}

export function splitBookIntoChapters(text: string, lang: string): BookChapter[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').trim();
  if (!clean) return [];

  // 1) Line-based headings (Word files keep paragraph breaks).
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  // Running-header suppression: count how often each candidate heading
  // title repeats, and ignore titles that repeat past the running-header
  // threshold (see RUNNING_HEADER_MAX_OCCURRENCES).
  const titleCounts = new Map<string, number>();
  const isCandidate: boolean[] = lines.map((line, i) => {
    const candidate = looksLikeHeading(line, lines[i + 1]);
    if (candidate) {
      const key = normalizeHeading(line);
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    return candidate;
  });
  const chapters: BookChapter[] = [];
  let currentTitle: string | null = null;
  let currentText: string[] = [];
  const flush = () => {
    const body = currentText.join('\n').trim();
    if (body) {
      chapters.push({
        title: currentTitle ?? genericSectionTitle(chapters.length, lang),
        text: body,
      });
    }
    currentText = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isRealHeading =
      isCandidate[i] &&
      (titleCounts.get(normalizeHeading(line)) ?? 0) <= RUNNING_HEADER_MAX_OCCURRENCES;
    if (isRealHeading) {
      flush();
      currentTitle = line;
    } else {
      currentText.push(line);
    }
  }
  flush();
  if (chapters.length >= 2) {
    return finalizeChapters(chapters);
  }

  // 2) Inline "الفصل X" markers (flat PDF text).
  const inline = splitOnInlineMarkers(clean);
  if (inline && inline.length >= 2) {
    return finalizeChapters(inline);
  }

  // 3) No headings at all: even sections, so the whole book is still
  // covered instead of only its beginning.
  return finalizeChapters(splitIntoSizeSections(clean, lang));
}

interface ChapterSummary {
  title: string;
  ideas: string[];
}

async function summarizeChapter(
  ai: GoogleGenAI,
  chapter: BookChapter,
  lang: string,
  kind: 'book' | 'article' = 'book'
): Promise<ChapterSummary> {
  const langInstruction =
    lang === 'ar'
      ? 'Write the chapter title and ideas in clear, eloquent Arabic.'
      : lang === 'tr'
        ? 'Write the chapter title and ideas in clear, natural Turkish.'
        : 'Write the chapter title and ideas in clear, natural English.';

  const response = await generateContentWithFallback(ai, {
    contents: `Summarize ONLY this ${kind === 'article' ? 'section of an article' : 'chapter/section of a book'}. Extract:
1. The ${kind === 'article' ? 'section' : 'chapter'} title (use the heading provided below; clean it up if needed).
2. ALL main ideas of this ${kind === 'article' ? 'section' : 'chapter'}: every key idea, argument, example and conclusion — ${MAX_IDEAS_PER_CHAPTER} bullet points at most, each 1-2 sentences. Do NOT leave out any main idea: this is a comprehensive summary, not a short overview.
3. Do NOT invent ideas that are not in the text below. Do NOT add content from other ${kind === 'article' ? 'sections' : 'chapters'}.

${langInstruction}

${kind === 'article' ? 'Section' : 'Chapter'} heading: ${chapter.title}
${kind === 'article' ? 'Section' : 'Chapter'} text: ${chapter.text}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          ideas: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['title', 'ideas'],
      },
    },
  });

  const parsed = JSON.parse(response.text || '{}');
  const ideas = Array.isArray(parsed.ideas)
    ? parsed.ideas.map((idea: unknown) => String(idea).trim()).filter(Boolean)
    : [];
  if (ideas.length === 0) {
    throw new Error('Chapter summary came back empty');
  }
  return {
    title: String(parsed.title || chapter.title).trim(),
    ideas: ideas.slice(0, MAX_IDEAS_PER_CHAPTER),
  };
}

export async function summarizeBookFull(
  ai: GoogleGenAI,
  opts: { text: string; lang: string; requestStartedAt: number; kind?: 'book' | 'article' }
): Promise<{ summary: string; checklist: string[] }> {
  const kind = opts.kind ?? 'book';
  const chapters = splitBookIntoChapters(opts.text, opts.lang);
  if (chapters.length === 0) {
    throw new Error('No book content to summarize');
  }

  // All chapters in parallel: the wall clock is the slowest call, not
  // the sum — one sequential pass over 8 chapters would blow the 55s
  // frontend abort. Each call carries its own model fallback chain.
  const results = await Promise.allSettled(
    chapters.map((chapter) => summarizeChapter(ai, chapter, opts.lang, kind))
  );
  let failed = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === 'rejected');

  // One retry round for failed chapters, only while the request is still
  // young — retrying after ~25s would run into the frontend abort.
  if (failed.length > 0 && Date.now() - opts.requestStartedAt < RETRY_DEADLINE_MS) {
    const retries = await Promise.allSettled(
      failed.map(({ index }) => summarizeChapter(ai, chapters[index], opts.lang, kind))
    );
    retries.forEach((retry, i) => {
      if (retry.status === 'fulfilled') {
        results[failed[i].index] = retry;
      }
    });
    failed = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === 'rejected');
  }

  // Fail fast, like PR #5/#6: a "full" summary missing a chapter would
  // mislead the student into trusting it is complete. The route turns
  // this into 503 AI_UNAVAILABLE with no credit deducted.
  if (failed.length > 0) {
    throw new Error(
      `Could not summarize ${failed.length} of ${chapters.length} ${kind === 'article' ? 'sections' : 'chapters'}`
    );
  }

  const summaries = results.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('Unexpected chapter failure');
    return result.value;
  });

  // Plain text with one block per chapter: the library card renders the
  // summary as plain text (whitespace-pre-line in the PDF export), so no
  // Markdown headings — chapter titles on their own lines, ideas as
  // bullet points underneath.
  const summary = summaries
    .map(
      (chapter) =>
        `${chapter.title}\n${chapter.ideas.map((idea) => `• ${idea}`).join('\n')}`
    )
    .join('\n\n');

  // The card shows the checklist in a scrollable list, so the key ideas
  // stay visible even though the card clamps the summary text.
  const checklist: string[] = [];
  for (const chapter of summaries) {
    for (const idea of chapter.ideas.slice(0, 2)) {
      if (checklist.length >= MAX_CHECKLIST_ITEMS) break;
      checklist.push(idea);
    }
    if (checklist.length >= MAX_CHECKLIST_ITEMS) break;
  }

  return { summary, checklist };
}
