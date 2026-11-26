// Smoke test for the book-upload helpers (lib/book-upload.ts): the PDF
// decision and the notice shown after a successful save.
//
// Run: node scripts/smoke-book-upload.mjs
//
// No network needed: the helpers are pure, so the test compiles
// lib/book-upload.ts with the project's tsc (same pattern as
// scripts/smoke-book-summary.mjs) and asserts on the compiled output.
//
// Regression tests for the LIVE incident (2026-11-27 01:32): the Word
// book «اللغة الشاعرة» (111,897 bytes, 135,292 chars of real text)
// saved fine with 10 chapters and 79 ideas, yet the library still
// showed «هذا الكتاب مصوّر (Scan) وحجمه كبير (أكثر من 1.8MB)». The
// Word path can never set that warning (it lives only in the PDF
// branch), so the bar was stale: `notice` was never cleared on success.
// Section 2 covers the fix — a successful save with no warning of its
// own clears the bar — and section 1 covers the true-positive case: a
// genuinely scanned PDF over 1.8MB must still warn.

import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile the lib to a temp dir inside the project and import the
// compiled output (same pattern as scripts/smoke-book-summary.mjs).
const outDir = mkdtempSync(join(process.cwd(), '.tmp-book-upload-test-'));
try {
  execSync(
    `./node_modules/.bin/tsc lib/book-upload.ts --outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --declaration false`,
    { stdio: 'pipe' }
  );
} catch (error) {
  console.error('Failed to compile book-upload lib:', error.stdout?.toString(), error.stderr?.toString());
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
const {
  decidePdfBookPath,
  noticeAfterSave,
  BOOK_TEXT_MIN_CHARS,
  SCANNED_PDF_MAX_BYTES,
} = await import(join(outDir, 'book-upload.js'));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const MB = 1024 * 1024;
const SCANNED_WARNING_AR =
  'هذا الكتاب مصوّر (Scan) وحجمه كبير (أكثر من 1.8MB). جرب كتاباً نصياً أو ملفاً أصغر حجماً.';
const CONTENT_WARNING_AR =
  'تعذّر جلب محتوى الرابط، فالملخص مبني على العنوان فقط — قد يكون ناقصاً.';

// 1) PDF decision — the warning must fire only for a genuinely scanned
// PDF over the size limit (true positive), never for a text PDF.
check('limits are the live values (80 chars, 1.8MB)', BOOK_TEXT_MIN_CHARS === 80 && SCANNED_PDF_MAX_BYTES === 1.8 * MB);
check(
  'text PDF never warns, even when large',
  decidePdfBookPath(5000, 5 * MB) === 'text',
  decidePdfBookPath(5000, 5 * MB)
);
check(
  'text PDF at the 80-char boundary takes the text path',
  decidePdfBookPath(80, 5 * MB) === 'text',
  decidePdfBookPath(80, 5 * MB)
);
check(
  'small scanned PDF goes as Base64, no warning',
  decidePdfBookPath(0, 1 * MB) === 'scanned-small',
  decidePdfBookPath(0, 1 * MB)
);
check(
  'scanned PDF exactly at 1.8MB goes as Base64, no warning',
  decidePdfBookPath(10, 1.8 * MB) === 'scanned-small',
  decidePdfBookPath(10, 1.8 * MB)
);
check(
  'scanned PDF over 1.8MB warns (true positive)',
  decidePdfBookPath(0, 2.5 * MB) === 'scanned-too-large',
  decidePdfBookPath(0, 2.5 * MB)
);
check(
  'scanned PDF just over the limit warns (79 chars, 1.8MB + 1 byte)',
  decidePdfBookPath(79, 1.8 * MB + 1) === 'scanned-too-large',
  decidePdfBookPath(79, 1.8 * MB + 1)
);

// 2) Notice after a successful save — the live false positive.
// The Word book's own numbers: 111,897 bytes, 135,292 chars of real
// text. Even if it were a PDF it would take the text path, and the
// Word path never consults the PDF decision at all.
check(
  'live Word book numbers take the text path (no warning)',
  decidePdfBookPath(135292, 111897) === 'text',
  decidePdfBookPath(135292, 111897)
);
check(
  'Word book saves with no warning -> stale scanned warning cleared',
  noticeAfterSave(false, CONTENT_WARNING_AR) === '',
  JSON.stringify(noticeAfterSave(false, CONTENT_WARNING_AR))
);
check(
  'link save with no warning -> stale notice cleared',
  noticeAfterSave(false, '') === '',
  JSON.stringify(noticeAfterSave(false, ''))
);
check(
  'genuine content warning is still shown after a save',
  noticeAfterSave(true, CONTENT_WARNING_AR) === CONTENT_WARNING_AR,
  noticeAfterSave(true, CONTENT_WARNING_AR)
);
check(
  'stale warning text itself is never re-shown by a clean save',
  noticeAfterSave(false, SCANNED_WARNING_AR) === '',
  JSON.stringify(noticeAfterSave(false, SCANNED_WARNING_AR))
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
console.log('\nAll book-upload smoke checks passed');
