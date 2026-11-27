// End-to-end verification of the book PDF downloads (lib/book-reader.ts):
// the «تنزيل PDF» summary print (buildBookPrintHtml) and the Word ->
// PDF document (buildWordToPdfHtml, the «تحويل إلى PDF» button).
//
// Run: node scripts/verify-book-pdf.mjs
//
// This exercises the EXACT mechanism both buttons use: the printable
// document is rendered by headless Chromium and saved as a PDF (the
// browser's print-to-PDF path — the same path the user's browser takes
// when they choose «حفظ كملف PDF» from the print dialog). The script
// then proves each resulting PDF:
//   1. opens in a real PDF engine (pdfjs-dist, the library the app
//      already uses for PDF extraction),
//   2. has at least one page per chapter,
//   3. contains every chapter title and every idea detail as
//      extractable text (checked with pdftotext),
//   4. renders Arabic correctly (page 1 is rasterised with pdftoppm
//      for a visual check — see the printed PNG path).
//
// Why print-to-PDF instead of a binary PDF library: pdf-lib / jsPDF
// have no Arabic shaping engine, so they draw Arabic letters
// disconnected and in the wrong order; Vercel serverless cannot run
// Word/LibreOffice. The browser shapes Arabic correctly, keeps RTL
// order and uses the system's own naskh Arabic font. The original
// .docx layout (fonts, images, tables) is NOT preserved — the document
// is built from the extracted text and the AI summary.
//
// Needs: a headless Chromium binary (checked in order below) and
// poppler-utils (pdfinfo, pdftotext, pdftoppm). Skips with a clear
// message when Chromium is unavailable — the live browser test after
// deploy is then the verification.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import mammoth from 'mammoth';

const CHROMIUM_CANDIDATES = [
  join(process.env.HOME || '', '.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell'),
  join(process.env.HOME || '', '.cache/ms-playwright/chromium-1148/chrome-linux/chrome'),
  '/opt/meta-chromium/chrome',
];
const chromium = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
if (!chromium) {
  console.log('SKIP verify-book-pdf: no headless Chromium found (tried: ' + CHROMIUM_CANDIDATES.join(', ') + ')');
  console.log('Live browser verification after deploy is required instead.');
  process.exit(0);
}

const outDir = mkdtempSync(join(process.cwd(), '.tmp-book-pdf-test-'));
const workDir = mkdtempSync(join(tmpdir(), 'linkmind-book-pdf-'));
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Fingerprint for matching extracted PDF text against the original
// strings: NFKC decomposes Arabic presentation forms (shaped glyphs)
// back to standard letters, diacritics (incl. the shadda, which
// pdftotext sometimes reads before its letter) are dropped, and
// everything except letters and digits is dropped — pdftotext inserts
// bidi control characters, reorders digits inside RTL text and splits
// words at line breaks, so a plain substring match would fail even
// though the PDF is correct. Comparing letter-fingerprints is robust
// to all of that.
function fingerprint(text) {
  return text
    .normalize('NFKC')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[^\u0621-\u064A\u0660-\u0669\u06F0-\u06F9a-zA-Z0-9]/g, '');
}

try {
  execSync(
    `./node_modules/.bin/tsc lib/book-summary.ts lib/gemini.ts lib/book-reader.ts --outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --declaration false`,
    { stdio: 'pipe' }
  );
} catch (error) {
  console.error('Failed to compile book libs:', error.stdout?.toString(), error.stderr?.toString());
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
const { splitBookIntoChapters, summarizeBookFull } = await import(join(outDir, 'book-summary.js'));
const { buildBookPrintHtml, buildWordToPdfHtml } = await import(join(outDir, 'book-reader.js'));

// Same fake Gemini client as the smoke test (canned per-chapter JSON
// with idea details), so the PDF is built from a real structured book.
function makeFakeAi() {
  return {
    models: {
      generateContent: async (req) => {
        const contents = typeof req.contents === 'string' ? req.contents : '';
        const heading = contents.match(/(?:Chapter|Section) heading: (.+)\n/)?.[1] ?? 'Chapter';
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

// Build the book from the real Word file when present, otherwise from
// a synthetic long text with chapter headings.
let bookText;
let bookTitle = 'اللغة الشاعرة';
if (existsSync('test-files/allugha-alshaira.docx')) {
  const docx = await mammoth.extractRawText({ path: 'test-files/allugha-alshaira.docx' });
  bookText = docx.value;
} else {
  const LONG_AR = 'اللغة العربية لغة شعرية قديمة، وقد تطورت عبر القرون وتفرعت إلى لهجات وأساليب. '.repeat(40);
  bookText = ['الفصل الأول: البداية', LONG_AR, 'الفصل الثاني: النهاية', LONG_AR, 'الفصل الثالث: الخاتمة', LONG_AR].join('\n');
  bookTitle = 'كتاب اختبار';
}
const chapters = splitBookIntoChapters(bookText, 'ar');
console.log(`Book: ${bookText.length} chars -> ${chapters.length} chapters`);
const full = await summarizeBookFull(makeFakeAi(), {
  text: bookText,
  lang: 'ar',
  requestStartedAt: Date.now(),
});
check('structured book has >= 3 chapters', full.chapters.length >= 3, `${full.chapters.length}`);

// The print HTML: no auto-print script. The Arabic font comes from
// the system font stack in the document (Noto Naskh Arabic is
// installed on this machine), exactly as on a user's machine.
const bookHtml = buildBookPrintHtml({
  title: bookTitle,
  chapters: full.chapters,
  lang: 'ar',
  autoPrint: false,
});
const wordHtml = buildWordToPdfHtml({
  title: bookTitle,
  chapters: full.chapters,
  lang: 'ar',
  autoPrint: false,
});

// Print one HTML document to a real PDF with headless Chromium and
// prove the PDF: opens in pdfjs, has enough pages, contains every
// chapter title and idea detail as extractable text, and rasterises
// page 1 for a visual check of Arabic shaping + RTL.
async function verifyPrintPdf(tag, html, chapters) {
  const htmlPath = join(workDir, `${tag}.html`);
  const pdfPath = join(workDir, `${tag}.pdf`);
  writeFileSync(htmlPath, html);

  try {
    execFileSync(
      chromium,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--allow-file-access-from-files',
        '--virtual-time-budget=8000',
        `--print-to-pdf=${pdfPath}`,
        '--no-pdf-header-footer',
        pathToFileURL(htmlPath).href,
      ],
      { stdio: 'pipe', timeout: 120000 }
    );
  } catch (error) {
    console.error(`Chromium print-to-pdf failed (${tag}):`, error.stdout?.toString(), error.stderr?.toString());
    failures += 1;
  }
  check(`${tag}: pdf file was created`, existsSync(pdfPath));
  if (!existsSync(pdfPath)) return;

  const pdfBytes = readFileSync(pdfPath);
  check(`${tag}: pdf is non-empty`, pdfBytes.length > 1000, `${pdfBytes.length} bytes`);

  // 1) pdfinfo: opens and reports pages. The Word document has a
  // cover page plus one page per chapter, so it needs one more page
  // than the summary print.
  const minPages = tag === 'word' ? chapters.length + 1 : chapters.length;
  let pageCount = 0;
  try {
    const info = execSync(`pdfinfo ${JSON.stringify(pdfPath)}`, { encoding: 'utf8' });
    pageCount = Number(/Pages:\s+(\d+)/.exec(info)?.[1] || 0);
    console.log(`${tag} pdfinfo: ${pageCount} pages`);
  } catch (error) {
    console.error('pdfinfo failed:', error.message);
  }
  check(`${tag}: pdf has at least one page per chapter`, pageCount >= minPages, `${pageCount} pages / ${chapters.length} chapters`);

  // 2) pdfjs-dist opens the file (the same engine the app uses).
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs
      .getDocument({ data: new Uint8Array(pdfBytes), useWorker: false, isEvalSupported: false })
      .promise;
    check(`${tag}: pdfjs opens the pdf`, doc.numPages >= 1, `${doc.numPages} pages`);
  } catch (error) {
    check(`${tag}: pdfjs opens the pdf`, false, String(error));
  }

  // 3) pdftotext: the extracted text contains every chapter title and
  // at least one idea detail (matched by letter-fingerprint — see
  // fingerprint() above — because pdftotext inserts bidi controls and
  // reorders digits inside RTL text).
  let extracted = '';
  try {
    extracted = execSync(`pdftotext ${JSON.stringify(pdfPath)} -`, { encoding: 'utf8' });
  } catch (error) {
    console.error('pdftotext failed:', error.message);
  }
  const extractedFingerprint = fingerprint(extracted);
  const missingTitles = chapters
    .map((ch) => ch.title)
    .filter((t) => !extractedFingerprint.includes(fingerprint(t)));
  check(`${tag}: pdf text contains all chapter titles`, missingTitles.length === 0, missingTitles.join(' | '));
  const missingDetails = chapters
    .flatMap((ch) => ch.ideas.map((idea) => fingerprint(idea.detail.slice(0, 60))))
    .filter((snippet) => snippet.length > 10 && !extractedFingerprint.includes(snippet));
  check(`${tag}: pdf text contains idea details`, missingDetails.length === 0, `${missingDetails.length} missing`);

  // 4) Rasterise page 1 for a visual check of Arabic shaping + RTL.
  // pdftoppm pads the page number to the width of the total page
  // count (page-01.png for a 10-page PDF), so find the file by prefix.
  try {
    execSync(`pdftoppm -png -f 1 -l 1 -r 100 ${JSON.stringify(pdfPath)} ${JSON.stringify(join(workDir, `${tag}-page`))}`, { stdio: 'pipe' });
    const pngPath = readdirSync(workDir).find((f) => f.startsWith(`${tag}-page-`) && f.endsWith('.png'));
    check(`${tag}: page 1 rasterised for visual check`, Boolean(pngPath));
    if (pngPath) console.log(`${tag} visual check image: ${join(workDir, pngPath)}`);
  } catch (error) {
    check(`${tag}: page 1 rasterised for visual check`, false, String(error));
  }
  console.log(`${tag} PDF kept for inspection: ${pdfPath}`);
}

await verifyPrintPdf('book', bookHtml, full.chapters);
await verifyPrintPdf('word', wordHtml, full.chapters);

rmSync(outDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nBook PDF verification passed');
