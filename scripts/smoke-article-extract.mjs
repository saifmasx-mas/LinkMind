// Smoke test for lib/article-extract.ts (Blogger fetch fix).
//
// Run: node scripts/smoke-article-extract.mjs
//
// 1) A normal <p>-based article must come back through the primary pass.
// 2) A Blogger-style page whose post body lives in <div>s (no <p> tags
//    at all) must still yield its full text via the container fallback —
//    this is the template shape that used to return a thin, title-only
//    summary.
// 3) A page with no visible body text but a JSON-LD articleBody must
//    yield that text instead of nothing.

import { extractArticleText } from '../lib/article-extract.ts';

const para = (n) =>
  Array.from({ length: n }, (_, i) => `الفكرة رقم ${i + 1} في هذا المقال الطويل تشرح تفصيلا مهما عن الموضوع. `).join('');

const cases = [
  {
    name: 'p-based article (primary pass)',
    html: `<html><head><title>Test</title></head><body><article><h1>عنوان</h1><p>${para(20)}</p><p>${para(20)}</p></article></body></html>`,
    minChars: 1000,
    mustContain: 'الفكرة رقم 5',
  },
  {
    name: 'Blogger div-only body (container fallback)',
    html: `<html><head><title>Test</title></head><body><article><div class="post-body"><div>${para(20)}</div><div>${para(20)}</div></div></article></body></html>`,
    minChars: 1000,
    mustContain: 'الفكرة رقم 5',
  },
  {
    name: 'JSON-LD articleBody only',
    html: `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', articleBody: para(20) })}</script></head><body><article></article></body></html>`,
    minChars: 200,
    mustContain: 'الفكرة رقم 5',
  },
];

let failures = 0;
for (const { name, html, minChars, mustContain } of cases) {
  const text = extractArticleText(html);
  const ok = text.length >= minChars && text.includes(mustContain);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${text.length} chars (min ${minChars}), contains sample: ${text.includes(mustContain)}`);
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nAll article-extraction smoke checks passed');
