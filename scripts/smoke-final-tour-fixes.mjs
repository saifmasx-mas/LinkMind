// Smoke checks for the final-tour fixes (PR: fix/final-tour-fixes).
// Issue 1: the library must never render the "empty" message or a
// wrong balance before its data actually loads. Issue 2: the
// presentation page must say 31 merged PRs and must not present
// Facebook/Instagram as summarizable sources.
// Pure source checks — run with: node scripts/smoke-final-tour-fixes.mjs
import { readFileSync } from 'node:fs';

const page = readFileSync('app/page.tsx', 'utf8');
const translations = readFileSync('lib/translations.ts', 'utf8');
const presentation = readFileSync('app/presentation/page.tsx', 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

console.log('Issue 1 — false-empty library:');
// The loading flags exist and start false.
check('libraryLoaded state exists, initial false',
  page.includes('const [libraryLoaded, setLibraryLoaded] = useState(false)'));
check('profileLoaded state exists, initial false',
  page.includes('const [profileLoaded, setProfileLoaded] = useState(false)'));
// Both fetches mark loading done in a finally (error path included).
check('fetchBookmarks sets libraryLoaded in finally',
  /const fetchBookmarks[\s\S]*?finally \{[\s\S]*?setLibraryLoaded\(true\)/.test(page));
check('fetchUserProfile sets profileLoaded in finally',
  /const fetchUserProfile[\s\S]*?finally \{[\s\S]*?setProfileLoaded\(true\)/.test(page));
// Logout resets both flags so a fresh sign-in shows loading again.
check('logout resets libraryLoaded + profileLoaded',
  page.includes('setLibraryLoaded(false)') && page.includes('setProfileLoaded(false)'));
// The empty message is gated: loading branch comes BEFORE the
// filteredBookmarks.length === 0 branch.
const gridGate = page.indexOf('!libraryLoaded ? (');
const emptyBranch = page.indexOf('filteredBookmarks.length === 0 ? (');
check('empty state is gated behind !libraryLoaded',
  gridGate !== -1 && emptyBranch !== -1 && gridGate < emptyBranch);
check('loading block renders t.loadingLibrary',
  page.includes('{t.loadingLibrary}'));
check('Galaxy is gated behind libraryLoaded (no fake All (0))',
  page.includes('{libraryLoaded ? (') && page.includes('<OrbitalHub'));
// Balance shows a placeholder until the profile loads.
check('balance shows … while !profileLoaded',
  page.includes("!profileLoaded") && page.includes("? '…'"));
// The loading text exists in all three languages.
for (const lang of ['ar', 'tr', 'en']) {
  check(`loadingLibrary key exists (${lang})`,
    translations.includes('loadingLibrary:'));
}
check('loadingLibrary Arabic text is present',
  translations.includes("loadingLibrary: 'جارٍ تحميل مكتبتك…'"));
check('loadingLibrary Turkish text is present',
  translations.includes("loadingLibrary: 'Kitaplığınız yükleniyor…'"));
check('loadingLibrary English text is present',
  translations.includes("loadingLibrary: 'Loading your library…'"));

console.log('Issue 2 — presentation page:');
check('says 31 merged PRs', presentation.includes('31 طلب سحب مدموجة'));
check('no longer says 25 merged PRs', !presentation.includes('25 طلب سحب'));
check('Facebook removed from step 1 source list',
  presentation.includes('الصق رابط يوتيوب أو تيك توك أو إكس أو مقال') &&
  !presentation.includes('رابط يوتيوب أو فيسبوك أو تيك توك'));
check('honest Facebook/Instagram wording present',
  presentation.includes('فلا يتوفر لها ملخص كامل في أغلب الحالات'));
// Section 1 — the user's own dictated words, verbatim, untouched.
check('section 1 idea wording untouched',
  presentation.includes('ذاكرة سحابية ذكية: تلصق رابطاً أو ترفع كتاباً، فيحوّله الذكاء الاصطناعي إلى ملخص وخطوات عملية محفوظة في مكتبة قابلة للبحث.'));
check('section 1 problem wording untouched',
  presentation.includes('الروابط والفيديوهات والكتب تتراكم وتضيع، وإعادة قراءتها أو مشاهدتها تستهلك وقتاً طويلاً، ولا يوجد مكان واحد يجمعها مع ملخصاتها.'));
check('section 1 solution wording untouched',
  presentation.includes('مكان واحد يحفظ كل شيء مع ملخص ذكي وخطوات عملية، مع إمكانية سؤال المكتبة عن محفوظاتها بالمعنى.'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
