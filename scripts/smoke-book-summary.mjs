// Smoke test for the full-book summary (lib/book-summary.ts).
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
// Regression test for: books only ever sent their first ~14,000
// characters to Gemini with a "3-sentence summary" prompt, so the result
// covered only the most important ideas of the beginning of the book.
// Long articles pasted as links (a blog such as Blogger, or any other
// article page) use the same comprehensive path with kind: 'article'
// — section 9 below covers that.

import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mammoth from 'mammoth';

// Node's type stripping cannot resolve the extensionless './gemini'
// import, so compile the two libs to a temp dir inside the project
// (so require('@google/genai') still resolves from node_modules) and
// import the compiled output.
const outDir = mkdtempSync(join(process.cwd(), '.tmp-book-summary-test-'));
try {
  execSync(
    `./node_modules/.bin/tsc lib/book-summary.ts lib/gemini.ts --outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --declaration false`,
    { stdio: 'pipe' }
  );
} catch (error) {
  console.error('Failed to compile lib/book-summary.ts:', error.stdout?.toString(), error.stderr?.toString());
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
const { splitBookIntoChapters, summarizeBookFull } = await import(
  join(outDir, 'book-summary.js')
);

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
            ideas: [`الفكرة الأولى في ${heading} وهي مهمة للفهم.`, `الفكرة الثانية في ${heading} مع مثال توضيحي.`],
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

// 6) Full combine: one block per chapter, bullets, checklist capped.
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
console.log('\nAll full-book summary smoke checks passed');
