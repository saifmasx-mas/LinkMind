// Smoke test for the full-book summary (lib/book-summary.ts) and the
// book reader / print document (lib/book-reader.ts).
//
// Run: node scripts/smoke-book-summary.mjs
//
// No Gemini key and no network needed: chapter splitting is tested on
// the real «اللغة الشاعرة» Word file (test-files/allugha-alshaira.docx,
// extracted with mammoth exactly like the browser does) and on its raw
// OCR text, and the per-chapter summariser is tested with a fake Gemini
// client that returns canned JSON — which also exercises the retry round
// and the fail-fast behaviour (a chapter that still fails must fail the
// whole summary, never produce a partial "full" summary).
//
// Regression tests for the LIVE incident (2026-11-27 00:24): the real
// book was uploaded to the live site and saved with ONE generic
// section («القسم 1») + 8 ideas + a 2-item checklist, although the
// splitter proves the same file has 10 chapters. Sections 12-14 cover
// the fix: the route decision (every book takes the full path),
// the length-integrity guard (a book cut in transit is refused with
// 503 instead of being summarised from its beginning), and the
// flat-text shape that produces a single generic section. Sections
// 10-11 cover the structured chapters (envelope + plain-text fallback)
// and section 16 the printable book document (Word -> PDF).
// Section 20 covers the live retest findings (2026-11-27 01:02):
// chapter titles that skip numbers, and the card counter that said
// 12 while the reader showed 77 ideas.

import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mammoth from 'mammoth';

// Node's type stripping cannot resolve the extensionless './gemini'
// import, so compile the libs to a temp dir inside the project
// (so require('@google/genai') still resolves from node_modules) and
// import the compiled output.
const outDir = mkdtempSync(join(process.cwd(), '.tmp-book-summary-test-'));
try {
  execSync(
    `./node_modules/.bin/tsc lib/book-summary.ts lib/gemini.ts lib/book-reader.ts lib/source-detect.ts --outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --declaration false`,
    { stdio: 'pipe' }
  );
} catch (error) {
  console.error('Failed to compile book libs:', error.stdout?.toString(), error.stderr?.toString());
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
const {
  splitBookIntoChapters,
  summarizeBookFull,
  summarizeScannedBook,
  shouldUseFullSummary,
  isTruncatedBookText,
} = await import(join(outDir, 'book-summary.js'));
const {
  appendBookChapters,
  parseBookSummary,
  parsePlainSummaryToChapters,
  stripBookChapters,
  buildBookPrintHtml,
  renumberBookChapters,
  countBookIdeas,
} = await import(join(outDir, 'book-reader.js'));
const { detectSource } = await import(join(outDir, 'source-detect.js'));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const LONG_AR = 'اللغة العربية لغة شعرية قديمة، وقد تطورت عبر القرون وتفرعت إلى لهجات وأساليب. '.repeat(40);

// 1) Real Word file: mammoth output must split into the book's chapters.
// The fixture (test-files/allugha-alshaira.docx, the public-domain
// «اللغة الشاعرة» prepared for manual testing) is local-only and not
// committed — skip this check when it is absent.
if (existsSync('test-files/allugha-alshaira.docx')) {
  const docx = await mammoth.extractRawText({
    path: 'test-files/allugha-alshaira.docx',
  });
  const docxText = docx.value;
  const docxChapters = splitBookIntoChapters(docxText, 'ar');
  const docxTitles = docxChapters.map((c) => c.title);
  console.log(`\nWord file: ${docxText.length} chars -> ${docxChapters.length} chapters: ${docxTitles.join(' | ')}`);
  check('docx finds >= 5 chapters', docxChapters.length >= 5, `${docxChapters.length}`);
  // The book's own chapter titles, as printed in its contents page. Note
  // "اللغة الشاعرة" is deliberately NOT expected here: it is the book
  // title printed as a running header on (nearly) every page of the OCR
  // text, so the splitter treats it as a running header, not a chapter —
  // its content is still covered inside the surrounding chapters.
  for (const expected of ['فاتحة عريقة', 'لغة التعبير', 'الزمن في اللغة العربية', 'الشعر ديوان العرب', 'نقد الشعر العربي', 'النقد العلمي', 'المذاهب الغربية']) {
    check(`docx has chapter "${expected}"`, docxTitles.some((t) => t.includes(expected)));
  }
  check(
    'docx chapter titles are unique (no running-header duplicates)',
    new Set(docxTitles).size === docxTitles.length,
    docxTitles.join(' | ')
  );
  const docxCovered = docxChapters.reduce((n, c) => n + c.text.length, 0);
  check(
    'docx chapters cover >= 80% of the text',
    docxCovered >= docxText.length * 0.8,
    `${docxCovered}/${docxText.length}`
  );
  check('docx chapters capped at 10', docxChapters.length <= 10);
} else {
  console.log('\nSKIP real Word file checks (test-files/allugha-alshaira.docx not present)');
}

// 2) Raw OCR text (flat, noisy): headings must still be found.
if (existsSync('test-files/allugha-alshaira-raw.txt')) {
  const ocrText = readFileSync('test-files/allugha-alshaira-raw.txt', 'utf8');
  const ocrChapters = splitBookIntoChapters(ocrText, 'ar');
  console.log(`\nOCR text: ${ocrText.length} chars -> ${ocrChapters.length} chapters: ${ocrChapters.map((c) => c.title).join(' | ')}`);
  check('ocr finds >= 2 chapters', ocrChapters.length >= 2, `${ocrChapters.length}`);
} else {
  console.log('\nSKIP raw OCR text checks (test-files/allugha-alshaira-raw.txt not present)');
}

// 3) Flat text with inline "الفصل X" markers (PDF pages joined to one line).
const flatText = `مقدمة طويلة عن الكتاب. ${LONG_AR}الفصل الأول التعريف باللغة ${LONG_AR}الفصل الثاني تاريخ الشعر ${LONG_AR}الفصل الثالث النقد ${LONG_AR}`;
const flatChapters = splitBookIntoChapters(flatText, 'ar');
check('flat inline markers split into 3 chapters', flatChapters.length === 3, `${flatChapters.length}`);

// 4) English headings.
const enText = ['Chapter 1: Beginnings', LONG_AR, 'Chapter 2: Growth', LONG_AR, 'Chapter 3: Endings', LONG_AR].join('\n');
const enChapters = splitBookIntoChapters(enText, 'en');
check('english "Chapter N" headings split', enChapters.length === 3, `${enChapters.length}`);

// 5) No headings at all: even size sections, whole text covered.
const plainText = LONG_AR.repeat(6);
const plainChapters = splitBookIntoChapters(plainText, 'ar');
const plainCovered = plainChapters.reduce((n, c) => n + c.text.length, 0);
check('no-heading text splits into size sections', plainChapters.length >= 2, `${plainChapters.length}`);
check('size sections cover the whole text', plainCovered >= plainText.length * 0.95, `${plainCovered}/${plainText.length}`);

// Fake Gemini client: returns canned per-chapter JSON, parsing the
// chapter heading out of the prompt so titles come back correctly.
// Ideas are objects {text, detail} — the shape the real model is
// asked for, so the detail path is exercised too.
function makeFakeAi({ failOnceTitles = new Set(), failAlwaysTitles = new Set() } = {}) {
  let calls = 0;
  const seen = new Set();
  return {
    get calls() {
      return calls;
    },
    models: {
      generateContent: async (req) => {
        calls += 1;
        const contents = typeof req.contents === 'string' ? req.contents : '';
        const heading = contents.match(/(?:Chapter|Section) heading: (.+)\n/)?.[1] ?? 'Chapter';
        if (failAlwaysTitles.has(heading)) throw new Error('Request timed out');
        if (failOnceTitles.has(heading) && !seen.has(heading)) {
          seen.add(heading);
          throw new Error('Request timed out');
        }
        return {
          text: JSON.stringify({
            title: heading,
            ideas: [
              {
                text: `الفكرة الأولى في ${heading} وهي مهمة للفهم.`,
                detail: `تفصيل موسّع للفكرة الأولى في ${heading}: يشرح المؤلف هذه الفكرة بأمثلة من النص ويبين خطواتها وأدلتها، حتى يستطيع الطالب حفظها وفهمها بعمق.`,
              },
              {
                text: `الفكرة الثانية في ${heading} مع مثال توضيحي.`,
                detail: `تفصيل موسّع للفكرة الثانية في ${heading}: مثال عملي من الكتاب يوضح الفكرة، مع شرح الأسباب والنتائج المترتبة عليها.`,
              },
            ],
          }),
        };
      },
    },
  };
}

const twoChapterBook = [
  'الفصل الأول: البداية',
  LONG_AR,
  'الفصل الثاني: النهاية',
  LONG_AR,
].join('\n');

// 6) Full combine: one block per chapter, bullets, checklist capped,
// and structured chapters where every idea carries a detail.
const fakeAi = makeFakeAi();
const full = await summarizeBookFull(fakeAi, {
  text: twoChapterBook,
  lang: 'ar',
  requestStartedAt: Date.now(),
});
console.log(`\nCombined summary:\n${full.summary}\n`);
check('combined summary has both chapters', full.summary.includes('الفصل الأول') && full.summary.includes('الفصل الثاني'));
check('combined summary uses bullet points', full.summary.includes('• الفكرة الأولى'));
check('checklist has 4 items (2 per chapter)', full.checklist.length === 4, `${full.checklist.length}`);
check('no invented chapter titles', !full.summary.includes('Section'));
check('structured chapters returned (2)', Array.isArray(full.chapters) && full.chapters.length === 2, `${full.chapters?.length}`);
check(
  'every idea has a non-empty detail',
  (full.chapters || []).every((ch) =>
    ch.ideas.every((idea) => typeof idea.detail === 'string' && idea.detail.trim().length > idea.text.trim().length)
  )
);
check(
  'checklist items are idea texts',
  full.checklist.every((step) => step.startsWith('الفكرة'))
);

// 7) Retry recovery: a chapter failing once must succeed on retry.
const flakyAi = makeFakeAi({ failOnceTitles: new Set(['الفصل الأول: البداية']) });
const recovered = await summarizeBookFull(flakyAi, {
  text: twoChapterBook,
  lang: 'ar',
  requestStartedAt: Date.now(),
});
check('retry recovers a chapter that failed once', recovered.summary.includes('الفصل الأول') && flakyAi.calls > 2, `${flakyAi.calls} calls`);

// 8) Fail fast: a chapter failing on every attempt must fail the whole
// summary (never a partial "full" summary), with no credit deducted by
// the route — the route turns this into 503 AI_UNAVAILABLE.
const brokenAi = makeFakeAi({ failAlwaysTitles: new Set(['الفصل الثاني: النهاية']) });
let threw = false;
try {
  await summarizeBookFull(brokenAi, {
    text: twoChapterBook,
    lang: 'ar',
    requestStartedAt: Date.now(),
  });
} catch (error) {
  threw = true;
  console.log(`\nFail-fast error (expected): ${error instanceof Error ? error.message : error}`);
}
check('persistent chapter failure fails the whole summary', threw);

// 9) Article (blog) text: headings on their own lines split into
// sections, and kind: 'article' combines them the same way as chapters.
const articleText = [
  'ما هي المدونة',
  LONG_AR,
  'كيف تبدأ مدونتك',
  LONG_AR,
  'كتابة مقال جيد',
  LONG_AR,
].join('\n');
const articleSections = splitBookIntoChapters(articleText, 'ar');
check('article headings split into >= 3 sections', articleSections.length >= 3, `${articleSections.length}`);
const articleFull = await summarizeBookFull(makeFakeAi(), {
  text: articleText,
  lang: 'ar',
  requestStartedAt: Date.now(),
  kind: 'article',
});
check(
  'article summary has all sections',
  articleFull.summary.includes('ما هي المدونة') &&
    articleFull.summary.includes('كيف تبدأ مدونتك') &&
    articleFull.summary.includes('كتابة مقال جيد')
);
check('article summary uses bullet points', articleFull.summary.includes('• الفكرة الأولى'));
check('article checklist has 6 items (2 per section)', articleFull.checklist.length === 6, `${articleFull.checklist.length}`);

// 10) Storage envelope: structured chapters round-trip through the
// plain summary text, and every display/export helper strips it.
const stored = appendBookChapters(full.summary, full.chapters);
const parsed = parseBookSummary(stored);
check('envelope round-trips the chapters', parsed.chapters?.length === 2, `${parsed.chapters?.length}`);
check(
  'envelope round-trips idea details',
  parsed.chapters?.[0]?.ideas?.[0]?.detail === full.chapters[0].ideas[0].detail
);
check('display summary has no envelope', stripBookChapters(stored) === full.summary);
check('display summary has no JSON', !stripBookChapters(stored).includes('BOOK_CHAPTERS'));
check('plain summary without envelope parses to null chapters', parseBookSummary(full.summary).chapters === null);
check(
  'corrupt envelope degrades to plain text',
  parseBookSummary(`${full.summary}\n\n<!--BOOK_CHAPTERS_v1-->\n{not json`).chapters === null &&
    parseBookSummary(`${full.summary}\n\n<!--BOOK_CHAPTERS_v1-->\n{not json`).displaySummary === full.summary
);

// 11) Plain-text fallback: older rows (no envelope) still open in the
// reader — parsed back into chapters, and no idea ever opens empty.
const oldPlain = 'القسم 1: اللغات الشاعرة\n• الفكرة الأولى عن الشعر.\n• الفكرة الثانية عن النثر.\n\nالقسم 2: لغة التعبير\n• فكرة واحدة عن التعبير.';
const oldChapters = parsePlainSummaryToChapters(oldPlain);
check('fallback parses 2 chapters from plain text', oldChapters.length === 2, `${oldChapters.length}`);
check(
  'fallback ideas carry a detail',
  oldChapters.every((ch) => ch.ideas.every((idea) => idea.detail && idea.detail.trim().length > 0))
);
const proseOnly = 'هذا ملخص نثري قصير عن الكتاب كله في فقرة واحدة بلا نقاط.';
const proseChapters = parsePlainSummaryToChapters(proseOnly);
check('prose-only summary becomes 1 chapter', proseChapters.length === 1, `${proseChapters.length}`);
check('prose chapter keeps the whole text as detail', proseChapters[0].ideas[0].detail.includes('ملخص نثري'));
check('empty summary parses to no chapters', parsePlainSummaryToChapters('').length === 0);

// 12) Route decision: EVERY book takes the full path, whatever the
// file type — PDF or Word, extracted text or scanned (base64, where
// bodyContent is empty and the short path with the file still applies).
check(
  'book with text takes the full path',
  shouldUseFullSummary({ isBookOrDoc: true, isFullArticle: false, bodyContentLength: 135292 })
);
check(
  'book with tiny text still takes the full path',
  shouldUseFullSummary({ isBookOrDoc: true, isFullArticle: false, bodyContentLength: 100 })
);
check(
  'scanned book (no text, Gemini reads the file) does not take the text path',
  !shouldUseFullSummary({ isBookOrDoc: true, isFullArticle: false, bodyContentLength: 0 })
);
check(
  'long article takes the full path',
  shouldUseFullSummary({ isBookOrDoc: false, isFullArticle: true, bodyContentLength: 5000 })
);
check(
  'short page does not take the full path',
  !shouldUseFullSummary({ isBookOrDoc: false, isFullArticle: false, bodyContentLength: 5000 })
);
check(
  'video never takes the full path',
  !shouldUseFullSummary({ isBookOrDoc: false, isFullArticle: false, bodyContentLength: 0 })
);

// 13) Length-integrity guard: the live incident — the server received
// ~2,000 chars while the browser claimed ~135,000. Refuse; a full
// text (or a few percent of JSON overhead) must pass.
check('live case: 2000 received of 135292 claimed is truncated', isTruncatedBookText(2000, 135292));
check('full text received is not truncated', !isTruncatedBookText(135292, 135292));
check('within 5% tolerance is not truncated', !isTruncatedBookText(130000, 135292));
check('below 5% tolerance is truncated', isTruncatedBookText(120000, 135292));
check('no claim means no guard', !isTruncatedBookText(0, 0) && !isTruncatedBookText(500, 0));

// 14) PDF-shape flat text (no newlines at all): a long flat book must
// still split into several chapters — a single generic «القسم 1»
// only happens for a SHORT flat text, which is the live symptom.
const flatLong = (`مقدمة عن الكتاب. ${LONG_AR}الفصل الأول التعريف ${LONG_AR}الفصل الثاني التاريخ ${LONG_AR}الفصل الثالث النقد ${LONG_AR}الفصل الرابع الأسلوب ${LONG_AR}الفصل الخامس الخاتمة ${LONG_AR}`).replace(/\n/g, ' ');
const flatLongChapters = splitBookIntoChapters(flatLong, 'ar');
check('long flat PDF text splits into >= 5 chapters', flatLongChapters.length >= 5, `${flatLongChapters.length}`);
const flatShort = 'مقدمة قصيرة. الفصل الأول التعريف باللغة. نص قصير جداً.';
const flatShortChapters = splitBookIntoChapters(flatShort, 'ar');
check('short flat text is the single-section case (live symptom)', flatShortChapters.length === 1, `${flatShortChapters.length}`);

// 15) Source counts (live observation: the Word book was counted as
// PDF): the classifier must agree with the upload URL the route
// builds — file://word/ is Word, file://pdf/ is PDF.
check("file://word/ counts as word", detectSource('file://word/allugha-alshaera') === 'word');
check("file://pdf/ counts as pdf", detectSource('file://pdf/photosynthesis-test') === 'pdf');
check("file://doc/ counts as word", detectSource('file://doc/old-book') === 'word');

// 16) Printable book document (Word -> PDF): the print HTML contains
// every chapter title, every idea and every detail, in RTL, with the
// bundled Arabic font and a page break per chapter.
const printHtml = buildBookPrintHtml({
  title: 'اللغة الشاعرة',
  chapters: full.chapters,
  lang: 'ar',
  autoPrint: false,
});
check('print html is rtl', printHtml.includes('dir="rtl"'));
check(
  'print html uses a naskh arabic font stack',
  printHtml.includes("'Noto Naskh Arabic'") && printHtml.includes("'Traditional Arabic'")
);
check(
  'print html contains all chapter titles',
  full.chapters.every((ch) => printHtml.includes(ch.title))
);
check(
  'print html contains all ideas and details',
  full.chapters.every((ch) =>
    ch.ideas.every((idea) => printHtml.includes(idea.text) && printHtml.includes(idea.detail))
  )
);
check('print html breaks a page per chapter', printHtml.includes('page-break-before: always'));
check('print html has no auto-print script when disabled', !printHtml.includes('window.print()'));
const printHtmlAuto = buildBookPrintHtml({ title: 'x', chapters: full.chapters, lang: 'ar' });
check('print html auto-prints by default', printHtmlAuto.includes('window.print()'));
const printHtmlEn = buildBookPrintHtml({ title: 'Test', chapters: full.chapters, lang: 'en', autoPrint: false });
check('print html is ltr for english', printHtmlEn.includes('dir="ltr"'));

// 17) Real text-based PDF book: extracted with pdfjs exactly like the
// browser does, then through the full path with chapters + details.
if (existsSync('test-files/photosynthesis-test.pdf')) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfData = new Uint8Array(readFileSync('test-files/photosynthesis-test.pdf'));
  const pdfDoc = await pdfjs.getDocument({ data: pdfData, useWorker: false, isEvalSupported: false }).promise;
  let pdfText = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    pdfText += content.items.map((item) => item.str).join(' ') + '\n';
  }
  pdfText = pdfText.trim();
  console.log(`\nPDF book: ${pdfDoc.numPages} pages, ${pdfText.length} chars`);
  check('pdf book extracts real text', pdfText.length >= 80, `${pdfText.length}`);
  const pdfFull = await summarizeBookFull(makeFakeAi(), {
    text: pdfText,
    lang: 'en',
    requestStartedAt: Date.now(),
  });
  check('pdf book takes the full path with chapters', pdfFull.chapters.length >= 1, `${pdfFull.chapters.length}`);
  check(
    'pdf book ideas have details',
    pdfFull.chapters.every((ch) => ch.ideas.every((idea) => idea.detail && idea.detail.length > 0))
  );
} else {
  console.log('\nSKIP real PDF book checks (test-files/photosynthesis-test.pdf not present)');
}

// 18) The PDF version of the same book («اللغة الشاعرة», 94 pages):
// its text layer is real (137k chars), but stored in Arabic
// presentation forms — the splitter normalises them (NFKC). The PDF
// still splits into generic size sections, not real chapter titles:
// its pages are narrow (body lines ~70 chars), so the heading
// heuristic's "long following line" guard never fires, and the titles
// sit inline in the page text. That is a KNOWN LIMITATION, documented
// here, not a failure: the whole book is covered (see the coverage
// check) and the summary is complete and section-by-section — only
// the section titles are generic. A heading rule that finds them
// (next-3-lines combined) was tried and REVERTED: it promoted verse
// lines and subsection headings to chapters in the Word file and
// crowded out real chapters.
if (existsSync('test-files/allugha-alshaera.pdf')) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bigPdfData = new Uint8Array(readFileSync('test-files/allugha-alshaera.pdf'));
  const bigPdfDoc = await pdfjs.getDocument({ data: bigPdfData, useWorker: false, isEvalSupported: false }).promise;
  let bigPdfText = '';
  for (let i = 1; i <= bigPdfDoc.numPages; i++) {
    const page = await bigPdfDoc.getPage(i);
    const content = await page.getTextContent();
    bigPdfText += content.items.map((item) => item.str).join(' ') + '\n';
  }
  bigPdfText = bigPdfText.trim();
  console.log(`\nBig PDF book: ${bigPdfDoc.numPages} pages, ${bigPdfText.length} chars`);
  check('big pdf book extracts its full text', bigPdfText.length >= 100000, `${bigPdfText.length}`);
  const bigPdfChapters = splitBookIntoChapters(bigPdfText, 'ar');
  console.log(`Big PDF chapters: ${bigPdfChapters.map((c) => c.title).join(' | ')}`);
  check('big pdf book splits into >= 5 chapters', bigPdfChapters.length >= 5, `${bigPdfChapters.length}`);
  const bigPdfCovered = bigPdfChapters.reduce((n, c) => n + c.text.length, 0);
  check(
    'big pdf chapters cover >= 80% of the text',
    bigPdfCovered >= bigPdfText.length * 0.8,
    `${bigPdfCovered}/${bigPdfText.length}`
  );
  const bigPdfFull = await summarizeBookFull(makeFakeAi(), {
    text: bigPdfText,
    lang: 'ar',
    requestStartedAt: Date.now(),
  });
  check('big pdf book takes the full path', bigPdfFull.chapters.length >= 5, `${bigPdfFull.chapters.length}`);
  check(
    'big pdf book ideas have details',
    bigPdfFull.chapters.every((ch) => ch.ideas.every((idea) => idea.detail && idea.detail.length > 0))
  );
} else {
  console.log('\nSKIP big PDF book checks (test-files/allugha-alshaera.pdf not present)');
}

// 19) Scanned-book structured summary (a PDF with no text layer, sent
// to Gemini as base64): a good model answer becomes chapters with
// details; a bad answer returns null so the route falls back to the
// short summary instead of failing the upload.
function makeScannedFakeAi(responseText) {
  return { models: { generateContent: async () => ({ text: responseText }) } };
}
const scannedFull = await summarizeScannedBook(
  makeScannedFakeAi(
    JSON.stringify({
      chapters: [
        {
          title: 'الفصل الأول: البداية',
          ideas: [
            { text: 'فكرة أولى.', detail: 'تفصيل الفكرة الأولى من الكتاب الممسوح.' },
            { text: 'فكرة ثانية.', detail: 'تفصيل الفكرة الثانية من الكتاب الممسوح.' },
          ],
        },
        {
          title: 'الفصل الثاني: النهاية',
          ideas: [{ text: 'فكرة ثالثة.', detail: 'تفصيل الفكرة الثالثة من الكتاب الممسوح.' }],
        },
      ],
    })
  ),
  { base64: 'AAAA', mimeType: 'application/pdf', lang: 'ar' }
);
check('scanned book returns 2 chapters', scannedFull?.chapters.length === 2, `${scannedFull?.chapters.length}`);
check(
  'scanned book summary has both chapters',
  scannedFull?.summary.includes('الفصل الأول') && scannedFull?.summary.includes('الفصل الثاني')
);
check('scanned book checklist has 3 items', scannedFull?.checklist.length === 3, `${scannedFull?.checklist.length}`);
check(
  'scanned book ideas have details',
  scannedFull?.chapters.every((ch) => ch.ideas.every((idea) => idea.detail && idea.detail.length > 0))
);
check(
  'scanned book with bad json returns null',
  (await summarizeScannedBook(makeScannedFakeAi('{not json'), { base64: 'AAAA', mimeType: 'application/pdf', lang: 'ar' })) === null
);
check(
  'scanned book with no chapters returns null',
  (await summarizeScannedBook(makeScannedFakeAi(JSON.stringify({ chapters: [] })), { base64: 'AAAA', mimeType: 'application/pdf', lang: 'ar' })) === null
);

// 20) Live retest findings (2026-11-27 01:02): the reader showed
// chapter titles numbered 2, 3, 5, 7, 9, 11, 13, 15, 17, 18 (the
// book's own section numbers, copied by Gemini into its titles),
// and the card counter said (12) while the reader showed 77 ideas
// (the checklist column only holds 12 key items). Renumbering must
// happen at parse time so the already-saved live row is fixed with
// no re-upload, and the counter must equal the reader's total.
function makeIdeas(count, label) {
  return Array.from({ length: count }, (_, i) => ({
    text: `فكرة ${i + 1} من ${label}.`,
    detail: `تفصيل الفكرة ${i + 1} من ${label} في جملتين كاملتين.`,
  }));
}
const liveTitles = [
  'القسم الثاني: اللغة الشاعرة',
  'القسم 3',
  'القسم 5',
  'القسم السابع ولغة التعبير',
  'القسم 9',
  'القسم 11',
  'القسم 13',
  'القسم 15',
  'القسم 17',
  'القسم 18',
];
const liveIdeaCounts = [6, 8, 7, 8, 8, 8, 8, 8, 8, 8];
const liveChapters = liveTitles.map((title, i) => ({
  title,
  ideas: makeIdeas(liveIdeaCounts[i], title),
}));
const livePlain = liveChapters
  .map((ch) => `${ch.title}\n${ch.ideas.map((idea) => `• ${idea.text}`).join('\n')}`)
  .join('\n\n');
const liveStored = appendBookChapters(livePlain, liveChapters);
const liveParsed = parseBookSummary(liveStored);
const expectedLiveTitles = [
  'القسم 1: اللغة الشاعرة',
  'القسم 2',
  'القسم 3',
  'القسم 4: ولغة التعبير',
  'القسم 5',
  'القسم 6',
  'القسم 7',
  'القسم 8',
  'القسم 9',
  'القسم 10',
];
check(
  'live titles renumber sequentially 1..10 at parse time',
  JSON.stringify(liveParsed.chapters?.map((ch) => ch.title)) === JSON.stringify(expectedLiveTitles),
  liveParsed.chapters?.map((ch) => ch.title).join(' | ')
);
check(
  'renumbering keeps all 77 live ideas',
  countBookIdeas(liveParsed.chapters || []) === 77,
  `${countBookIdeas(liveParsed.chapters || [])}`
);
check(
  'renumbering is idempotent',
  JSON.stringify(renumberBookChapters(liveParsed.chapters || []).map((ch) => ch.title)) ===
    JSON.stringify(expectedLiveTitles)
);
check(
  'live display summary keeps the stored plain text',
  stripBookChapters(liveStored) === livePlain
);
// Plain-text fallback (older rows): non-sequential titles renumber too.
const oldSkipped = parsePlainSummaryToChapters(
  'القسم 5: لغة التعبير\n• فكرة عن التعبير.\n\nالقسم 9: الشعر\n• فكرة عن الشعر.'
);
check(
  'fallback titles renumber sequentially',
  JSON.stringify(oldSkipped.map((ch) => ch.title)) ===
    JSON.stringify(['القسم 1: لغة التعبير', 'القسم 2: الشعر']),
  oldSkipped.map((ch) => ch.title).join(' | ')
);
// Titles with no embedded number are preserved (the reader's badge
// already shows their position).
const noNumber = parsePlainSummaryToChapters(
  'المقدمة\n• فكرة تمهيدية.\n\nلغة التعبير\n• فكرة عن التعبير.'
);
check(
  'titles without a number are kept as-is',
  JSON.stringify(noNumber.map((ch) => ch.title)) === JSON.stringify(['المقدمة', 'لغة التعبير']),
  noNumber.map((ch) => ch.title).join(' | ')
);
const englishChapters = renumberBookChapters([
  { title: 'Section 3: Growth', ideas: makeIdeas(2, 'growth') },
  { title: 'Chapter 7', ideas: makeIdeas(1, 'end') },
]);
check(
  'english titles renumber sequentially',
  JSON.stringify(englishChapters.map((ch) => ch.title)) ===
    JSON.stringify(['Section 1: Growth', 'Chapter 2']),
  englishChapters.map((ch) => ch.title).join(' | ')
);
const bareNumber = renumberBookChapters([
  { title: '3. المقدمة', ideas: makeIdeas(1, 'intro') },
  { title: 'الثاني: اللغة الشاعرة', ideas: makeIdeas(1, 'lang') },
]);
check(
  'bare numbers are stripped, descriptive title kept',
  JSON.stringify(bareNumber.map((ch) => ch.title)) === JSON.stringify(['المقدمة', 'اللغة الشاعرة']),
  bareNumber.map((ch) => ch.title).join(' | ')
);
check('countBookIdeas is 0 for no chapters', countBookIdeas([]) === 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
console.log('\nAll full-book summary smoke checks passed');
