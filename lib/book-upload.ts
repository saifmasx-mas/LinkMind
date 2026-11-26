// Book-upload helpers (browser side): which path a PDF book takes, and
// which notice the bar shows after a successful save. Pure functions,
// covered by scripts/smoke-book-upload.mjs.
//
// FALSE-POSITIVE FIX (2026-11-27): after uploading the Word book
// «اللغة الشاعرة» (111,897 bytes, real text, 10 chapters, 79 ideas) the
// library still showed «هذا الكتاب مصوّر (Scan) وحجمه كبير (أكثر من
// 1.8MB)». The Word path can never set that warning — it lives only in
// the PDF branch of handleFileUpload (app/page.tsx). The notice bar was
// stale: `notice` was never cleared on success, so a warning set by an
// earlier action in the same page session stayed pinned above the
// library and was misread as describing the book that had just saved
// fine. `noticeAfterSave` fixes that: a successful save with no warning
// of its own clears any stale notice, while a genuine warning is kept.

// A PDF counts as "text" when the browser could extract at least this
// many characters from it; below that it is treated as scanned
// (image-only).
export const BOOK_TEXT_MIN_CHARS = 80;
// A scanned PDF up to this size is sent to the server as Base64 for
// Gemini to read; above it the site cannot process it.
export const SCANNED_PDF_MAX_BYTES = 1.8 * 1024 * 1024;

export type PdfBookPath = 'text' | 'scanned-small' | 'scanned-too-large';

// Which path a PDF book takes, from what the browser extracted locally.
// Only 'scanned-too-large' shows the "scanned book" warning: a text PDF
// never warns, and a small scanned PDF is sent as Base64 instead.
// Word (.docx) and text files never reach this decision — they take
// their own text path in handleFileUpload.
export function decidePdfBookPath(
  extractedTextLength: number,
  fileSize: number
): PdfBookPath {
  if (extractedTextLength >= BOOK_TEXT_MIN_CHARS) return 'text';
  if (fileSize <= SCANNED_PDF_MAX_BYTES) return 'scanned-small';
  return 'scanned-too-large';
}

// The notice bar after a successful save: keep a genuine warning the
// save itself carries, otherwise clear the bar so a stale warning from
// an earlier action is not misread as describing the item just saved.
export function noticeAfterSave(
  contentWarning: boolean,
  contentWarningText: string
): string {
  return contentWarning ? contentWarningText : '';
}
